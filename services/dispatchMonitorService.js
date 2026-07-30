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
            COALESCE(dts.last_processed_location_log_id, 0) AS cursor_id
          FROM dispatch_tracking_sessions dts
          INNER JOIN dispatch_tickets dt
            ON dt.id = dts.dispatch_ticket_id
          WHERE dts.unlinked_at IS NULL
            AND dts.is_primary = 1
            AND dt.status IN ('dispatched', 'in_progress', 'returning_to_wmo')
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
        ORDER BY recorded_at ASC, id ASC
        LIMIT ?
      `,
      [
        relation.tracking_session_id,
        Number(relation.cursor_id || 0),
        LOCATION_BATCH_SIZE
      ]
    );

    for (const locationLog of logs) {
      await this.dispatchService.processAutomaticLocationLog(
        relation.id,
        locationLog
      );
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
module.exports.WMO_LOCATION = WMO_LOCATION;
