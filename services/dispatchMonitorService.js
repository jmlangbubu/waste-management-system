const db = require("../config/dbPromise");
const dispatchService = require("./dispatchService");

const INITIAL_DELAY_MS = 15000;
const MONITOR_DELAY_MS = 15000;
const LOCATION_BATCH_SIZE = 500;
const WMO_LOCATION = Object.freeze({
  latitude: 6.1060875,
  longitude: 125.1816406,
  radiusMeters: 100
});

function chronologyMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !value.trim()) return Number.NaN;
  const normalized = value.includes("T")
    ? value
    : `${value.trim().replace(" ", "T")}+08:00`;
  return Date.parse(normalized);
}

class DispatchMonitorService {
  constructor(pool = db, service = dispatchService) {
    this.db = pool;
    this.dispatchService = service;
    this.started = false;
    this.running = false;
    this.timer = null;
    this.missingTablesWarningLogged = false;
  }

  scheduleNextRun(delayMs = MONITOR_DELAY_MS) {
    if (!this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle();
    }, delayMs);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.scheduleNextRun(INITIAL_DELAY_MS);
  }

  stop() {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runCycle() {
    if (!this.started) return;
    if (this.running) {
      console.warn("[Dispatch Monitor] Previous cycle is still running; skipping overlap.");
      this.scheduleNextRun();
      return;
    }

    this.running = true;
    try {
      const [relations] = await this.db.query(
        `
          SELECT
            dts.id,
            dts.tracking_session_id,
            COALESCE(dts.last_processed_location_log_id, 0) AS cursor_id,
            dt.status AS dispatch_status
          FROM dispatch_tracking_sessions dts
          INNER JOIN dispatch_tickets dt
            ON dt.id = dts.dispatch_ticket_id
          WHERE dts.unlinked_at IS NULL
            AND dts.is_primary = 1
            AND (
              dt.status IN ('dispatched', 'in_progress', 'returning_to_wmo')
              OR EXISTS (
                SELECT 1
                FROM truck_location_logs tll_new
                WHERE tll_new.session_id = dts.tracking_session_id
                  AND tll_new.id > COALESCE(
                    dts.last_processed_location_log_id,
                    0
                  )
              )
            )
          ORDER BY dts.id ASC
        `
      );

      for (const relation of relations) {
        await this.processRelation(relation);
      }
      this.missingTablesWarningLogged = false;
    } catch (error) {
      if (dispatchService.isDispatchTableMissingError(error)) {
        if (!this.missingTablesWarningLogged) {
          console.warn(
            "[Dispatch Monitor] Dispatch database setup is required; monitoring is paused until the dispatch tables exist."
          );
          this.missingTablesWarningLogged = true;
        }
      } else {
        console.error("[Dispatch Monitor] Cycle failed:", error);
      }
    } finally {
      this.running = false;
      this.scheduleNextRun();
    }
  }

  async processRelation(relation) {
    let cursorId = Number(relation.cursor_id || 0);
    let latestProcessedRecordedAtMs = Number.NaN;
    let priorChronologyLoaded = cursorId === 0;

    while (true) {
      const [logs] = await this.db.query(
        `
          SELECT
            id,
            session_id,
            latitude,
            longitude,
            accuracy,
            recorded_at
          FROM truck_location_logs
          WHERE session_id = ?
            AND id > ?
          ORDER BY id ASC
          LIMIT ?
        `,
        [relation.tracking_session_id, cursorId, LOCATION_BATCH_SIZE]
      );

      if (!logs.length) break;

      if (!priorChronologyLoaded) {
        const [chronologyRows] = await this.db.query(
          `
            SELECT
              DATE_FORMAT(MAX(recorded_at), '%Y-%m-%d %H:%i:%s')
                AS latest_processed_recorded_at
            FROM truck_location_logs
            WHERE session_id = ?
              AND id <= ?
          `,
          [relation.tracking_session_id, cursorId]
        );
        latestProcessedRecordedAtMs = chronologyMs(
          chronologyRows[0]?.latest_processed_recorded_at
        );
        priorChronologyLoaded = true;
      }

      let pagePreviousRecordedAtMs = latestProcessedRecordedAtMs;
      let requiresReplay = ["completed", "cancelled"].includes(
        relation.dispatch_status
      );

      for (const locationLog of logs) {
        const recordedAtMs = chronologyMs(locationLog.recorded_at);
        if (
          !Number.isFinite(recordedAtMs) ||
          (Number.isFinite(pagePreviousRecordedAtMs) &&
            recordedAtMs < pagePreviousRecordedAtMs)
        ) {
          requiresReplay = true;
          break;
        }
        pagePreviousRecordedAtMs = recordedAtMs;
      }

      if (requiresReplay) {
        await this.dispatchService.reconcileAutomaticDispatchHistory(
          relation.id
        );
        await this.dispatchService.reconcileEndedTrackingSession(
          relation.id,
          WMO_LOCATION
        );
        return;
      }

      for (const locationLog of logs) {
        await this.dispatchService.processAutomaticLocationLog(
          relation.id,
          locationLog
        );
        cursorId = Number(locationLog.id);
        latestProcessedRecordedAtMs = chronologyMs(locationLog.recorded_at);
      }

      if (logs.length < LOCATION_BATCH_SIZE) break;
    }

    await this.dispatchService.reconcileEndedTrackingSession(
      relation.id,
      WMO_LOCATION
    );
  }
}

const dispatchMonitorService = new DispatchMonitorService();

module.exports = dispatchMonitorService;
module.exports.DispatchMonitorService = DispatchMonitorService;
module.exports.INITIAL_DELAY_MS = INITIAL_DELAY_MS;
module.exports.MONITOR_DELAY_MS = MONITOR_DELAY_MS;
module.exports.LOCATION_BATCH_SIZE = LOCATION_BATCH_SIZE;
module.exports.WMO_LOCATION = WMO_LOCATION;
