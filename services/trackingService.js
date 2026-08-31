const db = require("../config/dbPromise");
const {
    GpsValidationError,
    MAX_RELIABLE_ACCURACY_METERS,
    parseManilaTimestamp,
    validateGpsPointForStorage,
    qualifyGpsPointForOperationalUse
} = require("../utils/gpsValidation");

const WMO_GEOFENCE = Object.freeze({
    latitude: 6.1060875,
    longitude: 125.1816406,
    radiusMeters: 100
});

class TrackingStartEligibilityError extends Error {
    constructor(message, code, statusCode = 400) {
        super(message);
        this.name = "TrackingStartEligibilityError";
        this.code = code;
        this.statusCode = statusCode;
    }
}

class TrackingEndOperationsError extends Error {
    constructor(message, code, statusCode = 400) {
        super(message);
        this.name = "TrackingEndOperationsError";
        this.code = code;
        this.statusCode = statusCode;
    }
}

class TrackingService {
    constructor(options = {}) {
        this.trackingStartOperations = new Map();
        this.dispatchService = options.dispatchService || null;
    }

    getDispatchLifecycleService() {
        if (!this.dispatchService) {
            this.dispatchService = require("./dispatchService");
        }
        return this.dispatchService;
    }

    cleanText(value) {
        if (value === null || value === undefined) return "";

        const text = String(value).trim();

        if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
            return "";
        }

        return text;
    }

    getManilaNowDateTime() {
        /*
          Server hosting can use UTC while WMO operational timestamps use
          Philippine time. Keep stored lifecycle timestamps in Manila time.
        */
        const now = new Date(Date.now() + (8 * 60 * 60 * 1000));
        return now.toISOString().slice(0, 19).replace("T", " ");
    }

    normalizeDateTimeText(value) {
        if (value === null || value === undefined) return "";

        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value.toISOString().slice(0, 19).replace("T", " ");
        }

        const cleaned = this.cleanText(value);
        if (!cleaned) return "";

        if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(cleaned)) {
            return cleaned;
        }

        if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) {
            return cleaned.replace("T", " ").replace(/\.\d{3}Z?$/, "").replace(/Z$/, "").slice(0, 19);
        }

        const parsed = new Date(cleaned);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString().slice(0, 19).replace("T", " ");
        }

        return cleaned.slice(0, 19);
    }

    parseManilaDateTimeMs(value) {
        const text = this.normalizeDateTimeText(value);
        if (!text) return 0;

        const parsed = new Date(`${text.replace(" ", "T")}+08:00`);
        const time = parsed.getTime();
        return Number.isNaN(time) ? 0 : time;
    }

    normalizeReliableLocation(location = {}, referenceTime = this.getManilaNowDateTime()) {
        const referenceTimeMs = typeof referenceTime === "number"
            ? referenceTime
            : parseManilaTimestamp(referenceTime);
        const qualification = qualifyGpsPointForOperationalUse(location, {
            referenceTimeMs: referenceTimeMs || Date.now()
        });
        return qualification.reliable ? qualification.point : null;
    }

    calculateDistanceMeters(lat1, lon1, lat2, lon2) {
        return this.calculateDistanceKm(lat1, lon1, lat2, lon2) * 1000;
    }

    validateNewTrackingStartLocation(data = {}, referenceTimeMs = Date.now()) {
        const requiredFields = ["latitude", "longitude", "accuracy", "recorded_at"];
        const missingEvidence = requiredFields.some((field) => (
            !Object.prototype.hasOwnProperty.call(data, field) ||
            data[field] === null ||
            data[field] === undefined ||
            (typeof data[field] === "string" && data[field].trim() === "")
        ));

        if (missingEvidence) {
            throw new TrackingStartEligibilityError(
                "Qualified GPS evidence is required to start a new tracking session.",
                "TRACKING_START_GPS_REQUIRED"
            );
        }

        const qualification = qualifyGpsPointForOperationalUse({
            latitude: data.latitude,
            longitude: data.longitude,
            accuracy: data.accuracy,
            recorded_at: data.recorded_at
        }, { referenceTimeMs });

        if (!qualification.reliable) {
            if (qualification.reason === "unreliable_accuracy") {
                throw new TrackingStartEligibilityError(
                    "GPS accuracy must be 50 meters or better to start tracking.",
                    "TRACKING_START_GPS_INACCURATE"
                );
            }

            if (qualification.reason === "stale_location") {
                throw new TrackingStartEligibilityError(
                    "A GPS sample from the last 5 minutes is required to start tracking.",
                    "TRACKING_START_GPS_STALE"
                );
            }

            if (qualification.reason === "GPS_TIMESTAMP_FUTURE") {
                throw new TrackingStartEligibilityError(
                    "The GPS sample time is too far in the future.",
                    "TRACKING_START_GPS_FUTURE"
                );
            }

            throw new TrackingStartEligibilityError(
                "The GPS evidence for starting tracking is invalid.",
                "TRACKING_START_GPS_INVALID"
            );
        }

        const distanceFromWmoMeters = this.calculateDistanceMeters(
            qualification.point.latitude,
            qualification.point.longitude,
            WMO_GEOFENCE.latitude,
            WMO_GEOFENCE.longitude
        );

        if (distanceFromWmoMeters > WMO_GEOFENCE.radiusMeters) {
            throw new TrackingStartEligibilityError(
                "A new tracking session can start only inside the WMO area.",
                "TRACKING_START_OUTSIDE_WMO"
            );
        }

        return {
            ...qualification.point,
            distanceFromWmoMeters
        };
    }

    normalizeMobileOperationIntent(value) {
        const intent = this.cleanText(value).toLowerCase();
        return ["end_operations", "forced_day_rollover"].includes(intent)
            ? intent
            : "";
    }

    validateMobileEndEvidence(data = {}, session = {}, referenceTimeMs = Date.now()) {
        const operationIntent = this.normalizeMobileOperationIntent(data.operation_intent);
        if (!operationIntent) return null;

        const actionId = this.cleanText(data.action_id);
        if (!actionId || actionId.length > 160) {
            throw new TrackingEndOperationsError(
                "A stable end-operation action ID is required.",
                "TRACKING_END_ACTION_ID_REQUIRED"
            );
        }

        const recordedAtMs = parseManilaTimestamp(data.recorded_at);
        if (!recordedAtMs) {
            throw new TrackingEndOperationsError(
                "A valid end-operation evidence time is required.",
                "TRACKING_END_TIMESTAMP_INVALID"
            );
        }
        if (recordedAtMs > referenceTimeMs + (60 * 1000)) {
            throw new TrackingEndOperationsError(
                "The end-operation evidence time is too far in the future.",
                "TRACKING_END_TIMESTAMP_FUTURE"
            );
        }

        const startedAtMs = parseManilaTimestamp(session.started_at);
        if (startedAtMs && recordedAtMs < startedAtMs) {
            throw new TrackingEndOperationsError(
                "The end-operation evidence cannot predate the tracking session.",
                "TRACKING_END_BEFORE_SESSION_START"
            );
        }

        const evidence = {
            operation_intent: operationIntent,
            action_id: actionId,
            recorded_at: this.normalizeDateTimeText(data.recorded_at),
            timestampMs: recordedAtMs,
            latitude: null,
            longitude: null,
            accuracy: null,
            distanceFromWmoMeters: null
        };

        if (operationIntent === "forced_day_rollover") {
            if (!/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(evidence.recorded_at)) {
                throw new TrackingEndOperationsError(
                    "Forced day rollover evidence must use the Asia/Manila midnight boundary.",
                    "TRACKING_DAY_ROLLOVER_TIMESTAMP_INVALID"
                );
            }
            return evidence;
        }

        let point;
        try {
            point = validateGpsPointForStorage({
                latitude: data.end_latitude,
                longitude: data.end_longitude,
                accuracy: data.end_accuracy,
                recorded_at: data.recorded_at
            }, {
                allowNumericString: true,
                nowMs: referenceTimeMs,
                timestampRequired: true
            });
        } catch (error) {
            if (error instanceof GpsValidationError) {
                throw new TrackingEndOperationsError(
                    "Qualified WMO GPS evidence is required to end operations.",
                    error.code || "TRACKING_END_GPS_INVALID"
                );
            }
            throw error;
        }

        if (
            point.accuracy === null ||
            point.accuracy > MAX_RELIABLE_ACCURACY_METERS
        ) {
            throw new TrackingEndOperationsError(
                "GPS accuracy must be 50 meters or better to end operations.",
                "TRACKING_END_GPS_INACCURATE"
            );
        }

        const distanceFromWmoMeters = this.calculateDistanceMeters(
            point.latitude,
            point.longitude,
            WMO_GEOFENCE.latitude,
            WMO_GEOFENCE.longitude
        );
        if (distanceFromWmoMeters > WMO_GEOFENCE.radiusMeters) {
            throw new TrackingEndOperationsError(
                "Return to the WMO area to end operations.",
                "TRACKING_END_OUTSIDE_WMO"
            );
        }

        return {
            ...evidence,
            latitude: point.latitude,
            longitude: point.longitude,
            accuracy: point.accuracy,
            distanceFromWmoMeters
        };
    }

    getTrackingStatusDescription(statusKey) {
        if (statusKey === "active") {
            return "Live GPS signal was syncing normally when tracking ended.";
        }

        if (statusKey === "sync_pending") {
            return "Mobile data was weak or offline when tracking ended. Saved points may sync later.";
        }

        if (statusKey === "gps_off") {
            return "GPS tracking was off or no live GPS points were recorded before tracking ended.";
        }

        return "Tracking session ended.";
    }

    getFinalGpsStatus(statusKey) {
        return statusKey === "gps_off" ? "off" : "on";
    }

    getFinalSyncStatus(statusKey) {
        if (statusKey === "active") return "synced";
        if (statusKey === "sync_pending") return "pending";
        return "not_syncing";
    }

    computeFinalTrackingStatus(session = {}, referenceTime = this.getManilaNowDateTime()) {
        const rawExplicitStatus = this.cleanText(
            session.last_location_status ||
            session.last_device_status ||
            session.tracking_status_key ||
            ""
        );

        const explicitStatus = rawExplicitStatus
            ? this.normalizeTrackingDeviceStatus(rawExplicitStatus)
            : "";

        if (explicitStatus === "gps_off" || explicitStatus === "sync_pending") {
            return explicitStatus;
        }

        const lastUpdated = this.normalizeDateTimeText(
            session.location_last_updated ||
            session.last_location_updated_at ||
            session.last_updated_at ||
            ""
        );

        if (!lastUpdated) {
            return "gps_off";
        }

        const referenceTimeMs = this.parseManilaDateTimeMs(referenceTime);
        const lastUpdatedMs = this.parseManilaDateTimeMs(lastUpdated);

        if (!referenceTimeMs || !lastUpdatedMs) {
            return explicitStatus || "gps_off";
        }

        const ageAtEndSeconds = Math.max(0, Math.floor((referenceTimeMs - lastUpdatedMs) / 1000));

        if (ageAtEndSeconds <= 60) {
            return "active";
        }

        if (ageAtEndSeconds <= 300) {
            return "sync_pending";
        }

        return "gps_off";
    }

    async ensureTrackingSessionReportColumns() {
        try {
            const [columns] = await db.query(`SHOW COLUMNS FROM truck_tracking_sessions`);
            const columnSet = new Set((columns || []).map((row) => String(row.Field || "").trim()));
            const alters = [];

            if (!columnSet.has("last_device_status")) {
                alters.push("ADD COLUMN last_device_status VARCHAR(50) NULL");
            }

            if (!columnSet.has("last_device_status_at")) {
                alters.push("ADD COLUMN last_device_status_at DATETIME NULL");
            }

            if (!columnSet.has("effective_shift_end_time")) {
                alters.push("ADD COLUMN effective_shift_end_time DATETIME NULL");
            }

            if (!columnSet.has("final_tracking_status_key")) {
                alters.push("ADD COLUMN final_tracking_status_key VARCHAR(50) NULL");
            }

            if (!columnSet.has("final_gps_status")) {
                alters.push("ADD COLUMN final_gps_status VARCHAR(20) NULL");
            }

            if (!columnSet.has("final_sync_status")) {
                alters.push("ADD COLUMN final_sync_status VARCHAR(50) NULL");
            }

            if (!columnSet.has("final_tracking_status_description")) {
                alters.push("ADD COLUMN final_tracking_status_description TEXT NULL");
            }

            if (alters.length > 0) {
                await db.query(`
                    ALTER TABLE truck_tracking_sessions
                    ${alters.join(",\n                    ")}
                `);
            }
        } catch (error) {
            console.error("ensureTrackingSessionReportColumns error:", error);
            /*
              Do not block tracking if optional report columns cannot be
              created immediately. Existing tracking still works.
            */
        }
    }


    async ensureOfflineTrackingColumns() {
        try {
            const [columns] = await db.query(`SHOW COLUMNS FROM truck_location_logs`);
            const columnSet = new Set((columns || []).map((row) => String(row.Field || "").trim()));

            const alters = [];

            if (!columnSet.has("local_point_id")) {
                alters.push("ADD COLUMN local_point_id VARCHAR(160) NULL");
            }

            if (!columnSet.has("sync_source")) {
                alters.push("ADD COLUMN sync_source VARCHAR(50) NULL");
            }

            if (alters.length > 0) {
                await db.query(`
                    ALTER TABLE truck_location_logs
                    ${alters.join(",\n                    ")}
                `);
            }

            const [indexes] = await db.query(`
                SELECT COUNT(1) AS index_count
                FROM INFORMATION_SCHEMA.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'truck_location_logs'
                  AND INDEX_NAME = 'uniq_session_local_point_id'
            `);

            const indexExists = Number(indexes && indexes[0] ? indexes[0].index_count : 0) > 0;

            if (!indexExists) {
                await db.query(`
                    ALTER TABLE truck_location_logs
                    ADD UNIQUE KEY uniq_session_local_point_id (session_id, local_point_id)
                `);
            }
        } catch (error) {
            console.error("ensureOfflineTrackingColumns error:", error);
            /*
              Do not block tracking because of optional migration failure.
              The normal GPS logging can still continue.
            */
        }
    }


    async getLatestReliableLocation(session = {}, referenceTime = this.getManilaNowDateTime()) {
        const [locationRows] = await db.query(
            `
            SELECT
                latitude,
                longitude,
                accuracy,
                DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s') AS recorded_at
            FROM truck_location_logs
            WHERE session_id = ?
              AND truck_id = ?
            ORDER BY recorded_at DESC, id DESC
            LIMIT 25
            `,
            [session.id, session.truck_id]
        );

        for (const locationRow of locationRows || []) {
            const reliableLocation = this.normalizeReliableLocation({
                ...locationRow,
                source: "truck_location_logs"
            }, referenceTime);

            if (reliableLocation) {
                return reliableLocation;
            }
        }

        return null;
    }

    async autoStopExpiredSessions() {
        // Kept as a compatibility no-op for older callers. Wall-clock time
        // must never transition an active tracking session to a stopped state.
        return {
            stopped_count: 0,
            reason: "time_based_auto_stop_disabled"
        };
    }

    startAutoStopScheduler() {
        return false;
    }

    stopAutoStopScheduler() {
        return false;
    }

    requestAutoStopCheck() {
        return false;
    }

    async ensureWmoNotificationsTableSafe() {
        /*
          The current notificationController reads WMO notifications using:
          SELECT * FROM notifications ORDER BY createdAt DESC

          So GPS notifications must use createdAt, not created_at.
          This helper keeps the tracking flow safe even if the notifications
          table is incomplete on local/hosted databases.
        */
        await db.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                type VARCHAR(100) NULL,
                title VARCHAR(255) NULL,
                message TEXT NULL,
                isRead TINYINT(1) NOT NULL DEFAULT 0,
                createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const [columns] = await db.query(`SHOW COLUMNS FROM notifications`);
        const columnSet = new Set((columns || []).map((row) => String(row.Field || "").trim()));
        const alters = [];

        if (!columnSet.has("type")) {
            alters.push("ADD COLUMN type VARCHAR(100) NULL");
        }

        if (!columnSet.has("title")) {
            alters.push("ADD COLUMN title VARCHAR(255) NULL");
        }

        if (!columnSet.has("message")) {
            alters.push("ADD COLUMN message TEXT NULL");
        }

        if (!columnSet.has("isRead")) {
            alters.push("ADD COLUMN isRead TINYINT(1) NOT NULL DEFAULT 0");
        }

        if (!columnSet.has("status")) {
            alters.push("ADD COLUMN status VARCHAR(80) NULL");
        }

        if (!columnSet.has("reference_id")) {
            alters.push("ADD COLUMN reference_id VARCHAR(120) NULL");
        }

        if (!columnSet.has("createdAt")) {
            alters.push("ADD COLUMN createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
        }

        if (alters.length > 0) {
            try {
                await db.query(`
                    ALTER TABLE notifications
                    ${alters.join(",\n                    ")}
                `);
            } catch (error) {
                if (error && error.code === "ER_DUP_FIELDNAME") {
                    console.warn("[DB] notifications optional column already exists.");
                } else {
                    throw error;
                }
            }
        }
    }

    async hasRecentGpsTrackingNotification(eventType, truckId) {
        const action = eventType === "off" ? "OFF" : "ON";

        const [rows] = await db.query(
            `
            SELECT id
            FROM notifications
            WHERE type = 'tracking'
              AND title = ?
              AND message LIKE ?
              AND createdAt >= (NOW() - INTERVAL 2 MINUTE)
            LIMIT 1
            `,
            [
                `GPS Tracking Turned ${action}`,
                `%Truck ${truckId}%`
            ]
        );

        return rows.length > 0;
    }

    async createGpsTrackingNotification(eventType, sessionData = {}) {
        try {
            await this.ensureWmoNotificationsTableSafe();

            const action = eventType === "off" ? "OFF" : "ON";
            const truckId = this.cleanText(sessionData.truck_id || sessionData.truckId || "Unknown Truck");
            const enforcerName = this.cleanText(sessionData.enforcer_name || sessionData.enforcerName || "");
            const sessionId = sessionData.session_id || sessionData.sessionId || sessionData.id || null;

            /*
              Prevent duplicate bell alerts if Android retries start/stop because
              of weak signal or if the service re-sends the same action quickly.
            */
            const hasRecent = await this.hasRecentGpsTrackingNotification(eventType, truckId);

            if (hasRecent) {
                return null;
            }

            const title = `GPS Tracking Turned ${action}`;
            const message = enforcerName
                ? `Truck ${truckId} GPS tracking was turned ${action} by ${enforcerName}.`
                : `Truck ${truckId} GPS tracking was turned ${action}.`;

            const [insertResult] = await db.query(
                `
                INSERT INTO notifications (
                    type,
                    title,
                    message,
                    status,
                    reference_id,
                    isRead
                )
                VALUES (?, ?, ?, ?, ?, 0)
                `,
                [
                    "tracking",
                    title,
                    message,
                    eventType === "off" ? "GPS off" : "GPS active",
                    sessionId ? String(sessionId) : null
                ]
            );

            const notificationId = insertResult && insertResult.insertId
                ? insertResult.insertId
                : null;

            return {
                id: notificationId,
                notification_id: notificationId,
                title,
                message,
                type: "tracking",
                status: eventType === "off" ? "GPS off" : "GPS active",
                truck_id: truckId,
                session_id: sessionId,
                reference_id: sessionId,
                createdAt: new Date().toISOString()
            };
        } catch (error) {
            /*
              Do not block GPS tracking if notification insert fails.
              Tracking data is more important than the notification UI.
            */
            console.error("createGpsTrackingNotification error:", error);
            return null;
        }
    }

    normalizeStopType(stopType) {
        const cleaned = this.cleanText(stopType).toLowerCase();

        if ([
            "manual_stopped",
            "manual_wmo_stop",
            "wmo_stop",
            "stopped",
            "auto_stopped",
            "auto_wmo_stop"
        ].includes(cleaned)) {
            return cleaned;
        }

        return "stopped";
    }

    getTrackingCompletedStatusLabelFromSession(sessionData = {}) {
        const statusMeta = this.buildTrackingReportStatus(sessionData || {});
        const label = this.cleanText(statusMeta.report_status_label);

        if (label) {
            return label;
        }

        return this.getTrackingCompletedStatusLabel(
            sessionData.stop_type || sessionData.stopType || sessionData.session_status || "stopped",
            sessionData.final_tracking_status_key || sessionData.finalTrackingStatusKey || sessionData.last_device_status || ""
        );
    }

    getTrackingCompletedStatusLabel(stopType, finalStatusKey = "") {
        const normalizedStopType = this.normalizeStopType(stopType);
        const normalizedFinalStatus = this.normalizeTrackingDeviceStatus(finalStatusKey || "active");

        if (normalizedStopType === "auto_wmo_stop") {
            return "Shift Completed · Route Recorded";
        }

        if (normalizedStopType === "auto_stopped") {
            if (normalizedFinalStatus === "gps_off") return "Shift Completed · No GPS Route";
            if (normalizedFinalStatus === "sync_pending") return "Shift Completed · Sync Pending";
            return "Shift Completed · Route Recorded";
        }

        if (normalizedFinalStatus === "gps_off") {
            return "Stopped · No GPS Route";
        }

        if (normalizedFinalStatus === "sync_pending") {
            return "Stopped · Sync Pending";
        }

        return "Manually Stopped · Route Recorded";
    }

    async hasTrackingCompletedNotification(sessionId) {
        const cleanSessionId = this.cleanText(sessionId);

        if (!cleanSessionId) {
            return false;
        }

        await this.ensureWmoNotificationsTableSafe();

        const [rows] = await db.query(
            `
            SELECT id
            FROM notifications
            WHERE type = 'tracking_completed'
              AND reference_id = ?
            LIMIT 1
            `,
            [cleanSessionId]
        );

        return rows.length > 0;
    }

    async getTrackingNotificationSessionContext(sessionId, fallbackData = {}) {
        const cleanSessionId = this.cleanText(sessionId || fallbackData.session_id || fallbackData.sessionId || fallbackData.id);

        if (!cleanSessionId) {
            return fallbackData || {};
        }

        try {
            await this.ensureTrackingSessionReportColumns();

            const [rows] = await db.query(
                `
                SELECT
                    tts.id,
                    tts.id AS session_id,
                    tts.truck_id,
                    tts.enforcer_id,
                    tts.enforcer_name,
                    tts.device_id,
                    tts.session_status,
                    tts.started_at,
                    tts.ended_at,
                    tts.shift_end_time,
                    tts.effective_shift_end_time,
                    tts.last_updated_at,
                    tts.last_device_status,
                    tts.last_device_status_at,
                    tts.final_tracking_status_key,
                    tts.final_gps_status,
                    tts.final_sync_status,
                    tts.final_tracking_status_description,
                    tts.session_distance_km,
                    tll.status AS last_location_status,
                    tll.last_updated_at AS location_last_updated,
                    COALESCE(route_counts.route_logs_count, 0) AS route_logs_count
                FROM truck_tracking_sessions tts
                LEFT JOIN truck_last_locations tll
                    ON tts.id = tll.session_id
                LEFT JOIN (
                    SELECT session_id, COUNT(*) AS route_logs_count
                    FROM truck_location_logs
                    GROUP BY session_id
                ) route_counts
                    ON route_counts.session_id = tts.id
                WHERE tts.id = ?
                LIMIT 1
                `,
                [cleanSessionId]
            );

            if (rows.length > 0) {
                return {
                    ...(fallbackData || {}),
                    ...rows[0],
                    session_id: rows[0].session_id || rows[0].id || cleanSessionId
                };
            }
        } catch (error) {
            console.error("getTrackingNotificationSessionContext warning:", error);
        }

        return {
            ...(fallbackData || {}),
            session_id: cleanSessionId
        };
    }

    async createTrackingCompletedNotification(sessionData = {}) {
        try {
            await this.ensureWmoNotificationsTableSafe();

            const sessionId = sessionData.session_id || sessionData.sessionId || sessionData.id || null;
            const cleanSessionId = this.cleanText(sessionId);

            if (cleanSessionId && await this.hasTrackingCompletedNotification(cleanSessionId)) {
                return null;
            }

            const sessionContext = await this.getTrackingNotificationSessionContext(cleanSessionId, sessionData);

            const truckId = this.cleanText(sessionContext.truck_id || sessionContext.truckId || "Unknown Truck");
            const enforcerName = this.cleanText(sessionContext.enforcer_name || sessionContext.enforcerName || "");
            const stopType = this.normalizeStopType(
                sessionContext.stop_type ||
                sessionContext.stopType ||
                sessionContext.session_status ||
                "stopped"
            );
            const finalStatusKey = this.cleanText(
                sessionContext.final_tracking_status_key ||
                sessionContext.finalTrackingStatusKey ||
                sessionContext.last_device_status ||
                sessionContext.last_location_status ||
                ""
            );
            const statusLabel = this.getTrackingCompletedStatusLabelFromSession({
                ...sessionContext,
                stop_type: stopType,
                final_tracking_status_key: finalStatusKey
            });
            const endedAt = this.cleanText(sessionContext.ended_at || sessionContext.endedAt || "");

            const title = "Truck Tracking Completed";
            const messageParts = [
                `Truck ${truckId} completed tracking${enforcerName ? ` by ${enforcerName}` : ""}.`,
                `Status: ${statusLabel}.`
            ];

            if (endedAt) {
                messageParts.push(`Ended at: ${this.normalizeDateTimeText(endedAt)}.`);
            }

            const message = messageParts.join(" ");

            const [insertResult] = await db.query(
                `
                INSERT INTO notifications (
                    type,
                    title,
                    message,
                    status,
                    reference_id,
                    isRead
                )
                VALUES (?, ?, ?, ?, ?, 0)
                `,
                [
                    "tracking_completed",
                    title,
                    message,
                    statusLabel,
                    cleanSessionId || null
                ]
            );

            const notificationId = insertResult && insertResult.insertId
                ? insertResult.insertId
                : null;

            return {
                id: notificationId,
                notification_id: notificationId,
                title,
                message,
                type: "tracking_completed",
                status: statusLabel,
                truck_id: truckId,
                session_id: cleanSessionId || sessionId,
                reference_id: cleanSessionId || sessionId,
                stop_type: stopType,
                final_tracking_status_key: finalStatusKey || null,
                createdAt: new Date().toISOString()
            };
        } catch (error) {
            /*
              Do not block the tracking report if the bell notification fails.
              The completed session/report is still the source of truth.
            */
            console.error("createTrackingCompletedNotification error:", error);
            return null;
        }
    }

    async backfillTrackingCompletedNotifications(limit = 100) {
        try {
            await this.ensureWmoNotificationsTableSafe();
            await this.ensureTrackingSessionReportColumns();

            const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));

            const [sessions] = await db.query(
                `
                SELECT
                    tts.id,
                    tts.id AS session_id,
                    tts.truck_id,
                    tts.enforcer_id,
                    tts.enforcer_name,
                    tts.device_id,
                    tts.session_status,
                    tts.started_at,
                    tts.ended_at,
                    tts.shift_end_time,
                    tts.effective_shift_end_time,
                    tts.last_updated_at,
                    tts.last_device_status,
                    tts.last_device_status_at,
                    tts.final_tracking_status_key,
                    tts.final_gps_status,
                    tts.final_sync_status,
                    tts.final_tracking_status_description,
                    tts.session_distance_km,
                    tll.status AS last_location_status,
                    tll.last_updated_at AS location_last_updated,
                    COALESCE(route_counts.route_logs_count, 0) AS route_logs_count
                FROM truck_tracking_sessions tts
                LEFT JOIN truck_last_locations tll
                    ON tts.id = tll.session_id
                LEFT JOIN (
                    SELECT session_id, COUNT(*) AS route_logs_count
                    FROM truck_location_logs
                    GROUP BY session_id
                ) route_counts
                    ON route_counts.session_id = tts.id
                LEFT JOIN notifications n
                    ON n.type = 'tracking_completed'
                   AND CAST(n.reference_id AS UNSIGNED) = tts.id
                WHERE tts.session_status IN (
                    'stopped',
                    'auto_stopped',
                    'manual_stopped',
                    'manual_wmo_stop',
                    'wmo_stop',
                    'auto_wmo_stop'
                )
                  AND n.id IS NULL
                ORDER BY COALESCE(tts.ended_at, tts.updated_at, tts.started_at, tts.created_at) DESC
                LIMIT ${safeLimit}
                `
            );

            let createdCount = 0;

            for (const session of sessions || []) {
                const notification = await this.createTrackingCompletedNotification(session);

                if (notification) {
                    createdCount += 1;
                }
            }

            return createdCount;
        } catch (error) {
            console.error("backfillTrackingCompletedNotifications warning:", error);
            return 0;
        }
    }



    async startTrackingSession(data = {}) {
        const truckId = this.cleanText(data && data.truck_id);

        if (!truckId) {
            throw new TrackingStartEligibilityError(
                "truck_id is required",
                "TRACKING_START_TRUCK_REQUIRED"
            );
        }

        const activeOperation = this.trackingStartOperations.get(truckId);
        if (activeOperation) {
            const result = await activeOperation;
            return {
                ...result,
                alreadyActive: true
            };
        }

        const operation = this.startTrackingSessionForTruck({
            ...data,
            truck_id: truckId
        });
        this.trackingStartOperations.set(truckId, operation);

        try {
            return await operation;
        } finally {
            if (this.trackingStartOperations.get(truckId) === operation) {
                this.trackingStartOperations.delete(truckId);
            }
        }
    }

    async startTrackingSessionForTruck(data = {}) {
        await this.ensureTrackingSessionReportColumns();

        const {
            truck_id,
            enforcer_id = null,
            enforcer_name = null,
            device_id = null,
            shift_end_time
        } = data;

        const startedAt = this.getManilaNowDateTime();
        const compatibilityShiftEnd = this.normalizeDateTimeText(shift_end_time) || startedAt;

        const checkActiveSql = `
            SELECT id 
            FROM truck_tracking_sessions
            WHERE truck_id = ?
              AND session_status = 'active'
            LIMIT 1
        `;

        const [activeRows] = await db.query(checkActiveSql, [truck_id]);

        if (activeRows.length > 0) {
            await db.query(
                `
                UPDATE truck_tracking_sessions
                SET
                    last_device_status = 'active',
                    last_device_status_at = ?,
                    effective_shift_end_time = COALESCE(effective_shift_end_time, shift_end_time, ?),
                    updated_at = ?
                WHERE id = ?
                `,
                [startedAt, compatibilityShiftEnd, startedAt, activeRows[0].id]
            );

            const notification = await this.createGpsTrackingNotification("on", {
                truck_id,
                enforcer_id,
                enforcer_name,
                session_id: activeRows[0].id
            });

            return {
                alreadyActive: true,
                sessionId: activeRows[0].id,
                notification
            };
        }

        const startLocation = this.validateNewTrackingStartLocation(data, Date.now());
        const session = await this.createTrackingSessionWithConnection(db, {
            truck_id,
            enforcer_id,
            enforcer_name,
            device_id,
            started_at: startedAt,
            shift_end_time: compatibilityShiftEnd,
            start_location: startLocation
        });
        const sessionId = session.id;

        await this.upsertLastLocation({
            truck_id,
            session_id: sessionId,
            latitude: startLocation.latitude,
            longitude: startLocation.longitude,
            speed: null,
            accuracy: startLocation.accuracy,
            heading: null,
            altitude: null,
            recorded_at: startLocation.recorded_at,
            status: "active"
        });

        const notification = await this.createGpsTrackingNotification("on", {
            truck_id,
            enforcer_id,
            enforcer_name,
            session_id: sessionId
        });

        return {
            alreadyActive: false,
            sessionId,
            notification
        };
    }

    async createTrackingSessionWithConnection(connection, data = {}) {
        const truckId = this.cleanText(data.truck_id);
        if (!truckId) {
            throw new TrackingStartEligibilityError(
                "truck_id is required",
                "TRACKING_START_TRUCK_REQUIRED"
            );
        }

        const startedAt = this.normalizeDateTimeText(data.started_at)
            || this.getManilaNowDateTime();
        const shiftEndTime = this.normalizeDateTimeText(data.shift_end_time)
            || startedAt;
        const startLocation = data.start_location
            || this.validateNewTrackingStartLocation(data, Date.now());

        const [result] = await connection.query(
            `
            INSERT INTO truck_tracking_sessions (
                truck_id,
                enforcer_id,
                enforcer_name,
                device_id,
                session_status,
                started_at,
                shift_end_time,
                effective_shift_end_time,
                start_latitude,
                start_longitude,
                last_latitude,
                last_longitude,
                last_updated_at,
                last_device_status,
                last_device_status_at,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
            `,
            [
                truckId,
                data.enforcer_id ?? null,
                data.enforcer_name ?? null,
                data.device_id ?? null,
                startedAt,
                shiftEndTime,
                shiftEndTime,
                startLocation.latitude,
                startLocation.longitude,
                startLocation.latitude,
                startLocation.longitude,
                startLocation.recorded_at,
                startedAt,
                startedAt,
                startedAt
            ]
        );

        return {
            id: result.insertId,
            truck_id: truckId,
            enforcer_id: data.enforcer_id ?? null,
            enforcer_name: data.enforcer_name ?? null,
            device_id: data.device_id ?? null,
            session_status: "active",
            started_at: startedAt,
            start_location: startLocation
        };
    }


    async stopTrackingSession(sessionId, data = {}) {
        await this.ensureTrackingSessionReportColumns();

        let {
            end_latitude,
            end_longitude,
            stop_type = "stopped"
        } = data;
        const receivedAt = this.getManilaNowDateTime();
        const referenceTimeMs = parseManilaTimestamp(receivedAt) || Date.now();

        const getSessionSql = `
            SELECT
                tts.id,
                tts.truck_id,
                tts.enforcer_name,
                tts.session_status,
                DATE_FORMAT(tts.started_at, '%Y-%m-%d %H:%i:%s') AS started_at,
                DATE_FORMAT(tts.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
                DATE_FORMAT(tts.ended_at, '%Y-%m-%d %H:%i:%s') AS ended_at,
                tts.end_latitude,
                tts.end_longitude,
                tts.shift_end_time,
                tts.effective_shift_end_time,
                tts.last_updated_at,
                tts.last_device_status,
                tts.last_device_status_at,
                tll.status AS last_location_status,
                tll.last_updated_at AS location_last_updated
            FROM truck_tracking_sessions tts
            LEFT JOIN truck_last_locations tll
                ON tts.id = tll.session_id
            WHERE tts.id = ?
            LIMIT 1
        `;

        const [rows] = await db.query(getSessionSql, [sessionId]);

        if (rows.length === 0) {
            throw new Error("Tracking session not found");
        }

        const session = rows[0];
        const endEvidence = this.validateMobileEndEvidence(
            data,
            session,
            referenceTimeMs
        );
        if (endEvidence) {
            end_latitude = endEvidence.latitude;
            end_longitude = endEvidence.longitude;
            stop_type = endEvidence.operation_intent === "end_operations"
                ? "manual_wmo_stop"
                : "auto_stopped";
        } else {
            const hasEndLatitude = end_latitude !== null && end_latitude !== undefined;
            const hasEndLongitude = end_longitude !== null && end_longitude !== undefined;
            if (hasEndLatitude || hasEndLongitude) {
                const endPoint = validateGpsPointForStorage({
                    latitude: end_latitude,
                    longitude: end_longitude
                });
                end_latitude = endPoint.latitude;
                end_longitude = endPoint.longitude;
            } else {
                end_latitude = null;
                end_longitude = null;
            }
        }

        const allowedStopType = this.normalizeStopType(stop_type);
        const stoppedAt = endEvidence ? endEvidence.recorded_at : receivedAt;

        if (session.session_status !== "active") {
            const existingEndedAt = this.normalizeDateTimeText(session.ended_at);
            if (endEvidence && existingEndedAt === endEvidence.recorded_at) {
                await this.getDispatchLifecycleService()
                    .finalizeMobileTrackingEnd(sessionId, endEvidence);
            }
            const notification = await this.createTrackingCompletedNotification({
                ...session,
                session_id: sessionId,
                stop_type: session.session_status || "stopped"
            });

            return {
                success: true,
                message: "Session already stopped",
                truck_id: session.truck_id,
                already_stopped: true,
                notification
            };
        }

        const compatibilityShiftEnd = this.normalizeDateTimeText(
            session.effective_shift_end_time || session.shift_end_time
        ) || stoppedAt;
        const endedAt = stoppedAt;
        const finalStatusKey = this.computeFinalTrackingStatus(session, endedAt);
        const finalGpsStatus = this.getFinalGpsStatus(finalStatusKey);
        const finalSyncStatus = this.getFinalSyncStatus(finalStatusKey);
        const finalDescription = this.getTrackingStatusDescription(finalStatusKey);
        const lastLocationStatus = finalStatusKey === "active" ? "offline" : finalStatusKey;

        const updateSql = `
            UPDATE truck_tracking_sessions
            SET
                session_status = ?,
                ended_at = ?,
                effective_shift_end_time = ?,
                final_tracking_status_key = ?,
                final_gps_status = ?,
                final_sync_status = ?,
                final_tracking_status_description = ?,
                end_latitude = ?,
                end_longitude = ?,
                last_latitude = COALESCE(?, last_latitude),
                last_longitude = COALESCE(?, last_longitude),
                last_updated_at = ?,
                updated_at = ?
            WHERE id = ?
        `;

        await db.query(updateSql, [
            allowedStopType,
            endedAt,
            compatibilityShiftEnd,
            finalStatusKey,
            finalGpsStatus,
            finalSyncStatus,
            finalDescription,
            end_latitude,
            end_longitude,
            end_latitude,
            end_longitude,
            endedAt,
            this.getManilaNowDateTime(),
            sessionId
        ]);

        const updateLastLocationSql = `
            UPDATE truck_last_locations
            SET
                status = ?,
                updated_at = ?
            WHERE session_id = ?
        `;

        await db.query(updateLastLocationSql, [lastLocationStatus, this.getManilaNowDateTime(), sessionId]);

        if (endEvidence) {
            await this.getDispatchLifecycleService()
                .finalizeMobileTrackingEnd(sessionId, endEvidence);
        }

        const notification = await this.createTrackingCompletedNotification({
            truck_id: session.truck_id,
            enforcer_name: session.enforcer_name || "",
            session_id: sessionId,
            stop_type: allowedStopType,
            final_tracking_status_key: finalStatusKey,
            ended_at: endedAt
        });

        return {
            success: true,
            message: "Tracking session stopped successfully",
            truck_id: session.truck_id,
            already_stopped: false,
            notification
        };
    }

    async stopTrackingSessionByWebAdmin(sessionId, actor = {}) {
        const actorId = Number(actor.id ?? actor.actor_id);
        const actorName = this.cleanText(
            actor.full_name || actor.fullName || actor.username || actor.actor_name
        );
        if (!Number.isInteger(actorId) || actorId <= 0 || !actorName) {
            const error = new Error("Authenticated Web Admin identity is required");
            error.statusCode = 401;
            error.code = "WEB_SESSION_REQUIRED";
            throw error;
        }

        try {
            const result = await this.stopTrackingSession(sessionId, {
                stop_type: "manual_stopped"
            });
            return {
                ...result,
                stopped_by: {
                    id: actorId,
                    name: actorName
                }
            };
        } catch (error) {
            if (error.message === "Tracking session not found") {
                error.statusCode = 404;
                error.code = "TRACKING_SESSION_NOT_FOUND";
            }
            throw error;
        }
    }

    async addLocationLog(sessionId, data) {
        const result = await this.addSingleLocationLog(sessionId, data);
        this.requestAutoStopCheck();

        return {
            success: true,
            message: result.duplicate
                ? "Location already recorded"
                : "Location recorded successfully",
            duplicate: result.duplicate || false,
            local_point_id: result.local_point_id || null
        };
    }

    async addLocationLogsBatch(sessionId, data = {}) {
        await this.ensureOfflineTrackingColumns();

        if (data.locations !== undefined && !Array.isArray(data.locations)) {
            throw new GpsValidationError("locations must be an array");
        }
        const locations = Array.isArray(data.locations) ? data.locations : [];

        if (locations.length === 0) {
            return {
                success: true,
                message: "No location points to sync",
                inserted_count: 0,
                duplicate_count: 0,
                synced_local_point_ids: []
            };
        }

        const sortedLocations = locations
            .map((item, index) => {
                try {
                    return validateGpsPointForStorage(item);
                } catch (error) {
                    if (error instanceof GpsValidationError) {
                        error.message = `locations[${index}]: ${error.message}`;
                    }
                    throw error;
                }
            })
            .sort((a, b) => a.timestampMs - b.timestampMs);

        let insertedCount = 0;
        let duplicateCount = 0;
        const syncedLocalPointIds = [];
        const session = await this.getLocationLogSession(sessionId);

        for (const point of sortedLocations) {
            const result = await this.addSingleLocationLog(sessionId, point, {
                session,
                skipOfflineColumnCheck: true,
                skipRouteRecalculation: true
            });

            if (result.duplicate) {
                duplicateCount++;
            } else {
                insertedCount++;
            }

            if (result.local_point_id) {
                syncedLocalPointIds.push(result.local_point_id);
            }
        }

        /*
          A mobile request can contain dozens of queued points. Rebuilding the
          complete route after every point made the response exceed Android's
          15-second HTTP timeout. Preserve point-by-point idempotency, but do
          the expensive route/last-location rebuild once after the batch.
        */
        if (insertedCount > 0) {
            await this.recalculateSessionDistanceAndLatestLocation(sessionId, { session });
        }

        this.requestAutoStopCheck();

        return {
            success: true,
            message: "Location batch synced successfully",
            inserted_count: insertedCount,
            duplicate_count: duplicateCount,
            synced_local_point_ids: syncedLocalPointIds
        };
    }

    async getLocationLogSession(sessionId) {
        const sessionSql = `
            SELECT
                id,
                truck_id,
                session_status,
                DATE_FORMAT(shift_end_time, '%Y-%m-%d %H:%i:%s') AS shift_end_time,
                DATE_FORMAT(ended_at, '%Y-%m-%d %H:%i:%s') AS ended_at
            FROM truck_tracking_sessions
            WHERE id = ?
            LIMIT 1
        `;

        const [sessionRows] = await db.query(sessionSql, [sessionId]);

        if (sessionRows.length === 0) {
            throw new Error("Tracking session not found");
        }

        return sessionRows[0];
    }

    async addSingleLocationLog(sessionId, data, options = {}) {
        if (!options.skipOfflineColumnCheck) {
            await this.ensureOfflineTrackingColumns();
        }

        const validatedPoint = validateGpsPointForStorage(data);
        const {
            latitude,
            longitude,
            speed = null,
            accuracy = null,
            heading = null,
            altitude = null
        } = validatedPoint;

        const localPointId = this.cleanText(validatedPoint.local_point_id || validatedPoint.localPointId);
        const recordedAt = validatedPoint.recorded_at;

        const session = options.session || await this.getLocationLogSession(sessionId);

        if (localPointId) {
            const [existingPointRows] = await db.query(
                `
                SELECT id
                FROM truck_location_logs
                WHERE session_id = ?
                  AND local_point_id = ?
                LIMIT 1
                `,
                [sessionId, localPointId]
            );

            if (existingPointRows.length > 0) {
                return {
                    duplicate: true,
                    local_point_id: localPointId
                };
            }
        }

        const shiftEndMs = parseManilaTimestamp(session.shift_end_time);
        const endedAtMs = parseManilaTimestamp(session.ended_at);
        const pointTimeMs = validatedPoint.timestampMs;

        const isHistoricalPointBeforeEnd =
            localPointId &&
            !endedAtMs &&
            shiftEndMs &&
            pointTimeMs <= shiftEndMs;

        const isHistoricalPointBeforeStoppedTime =
            localPointId &&
            endedAtMs &&
            pointTimeMs <= endedAtMs;

        if (
            session.session_status !== "active" &&
            !isHistoricalPointBeforeEnd &&
            !isHistoricalPointBeforeStoppedTime
        ) {
            throw new Error("Tracking session is no longer active");
        }

        const logSql = `
            INSERT INTO truck_location_logs (
                session_id,
                truck_id,
                latitude,
                longitude,
                speed,
                accuracy,
                heading,
                altitude,
                local_point_id,
                sync_source,
                recorded_at,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        await db.query(logSql, [
            sessionId,
            session.truck_id,
            latitude,
            longitude,
            speed,
            accuracy,
            heading,
            altitude,
            localPointId || null,
            localPointId ? "mobile_offline_queue" : "mobile_live",
            recordedAt,
            this.getManilaNowDateTime()
        ]);

        if (!options.skipRouteRecalculation) {
            await this.recalculateSessionDistanceAndLatestLocation(sessionId);
        }

        return {
            duplicate: false,
            local_point_id: localPointId || null
        };
    }

    async recalculateSessionDistanceAndLatestLocation(sessionId, options = {}) {
        let session = options.session || null;
        if (!session) {
            const sessionSql = `
                SELECT id, truck_id, session_status
                FROM truck_tracking_sessions
                WHERE id = ?
                LIMIT 1
            `;

            const [sessionRows] = await db.query(sessionSql, [sessionId]);

            if (sessionRows.length === 0) return;

            session = sessionRows[0];
        }

        const logsSql = `
            SELECT
                latitude,
                longitude,
                speed,
                accuracy,
                heading,
                altitude,
                DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s') AS recorded_at
            FROM truck_location_logs
            WHERE session_id = ?
            ORDER BY recorded_at ASC, id ASC
        `;

        const [logs] = await db.query(logsSql, [sessionId]);

        let totalDistanceKm = 0;
        let previous = null;
        let latest = null;

        for (const log of logs || []) {
            if (previous) {
                const distance = this.calculateDistanceKm(
                    Number(previous.latitude),
                    Number(previous.longitude),
                    Number(log.latitude),
                    Number(log.longitude)
                );

                /*
                  Ignore extreme GPS jumps while preserving normal road movement.
                  This keeps reports more stable when mobile signal/GPS accuracy is poor.
                */
                if (Number.isFinite(distance) && distance >= 0 && distance <= 10) {
                    totalDistanceKm += distance;
                }
            }

            previous = log;
            latest = log;
        }

        if (!latest) return;

        await db.query(
            `
            UPDATE truck_tracking_sessions
            SET
                session_distance_km = ?,
                last_latitude = ?,
                last_longitude = ?,
                last_updated_at = ?,
                last_device_status = 'active',
                last_device_status_at = ?,
                updated_at = ?
            WHERE id = ?
            `,
            [
                Number(totalDistanceKm.toFixed(4)),
                latest.latitude,
                latest.longitude,
                latest.recorded_at,
                latest.recorded_at,
                this.getManilaNowDateTime(),
                sessionId
            ]
        );

        await this.upsertLastLocation({
            truck_id: session.truck_id,
            session_id: sessionId,
            latitude: latest.latitude,
            longitude: latest.longitude,
            speed: latest.speed,
            accuracy: latest.accuracy,
            heading: latest.heading,
            altitude: latest.altitude,
            recorded_at: latest.recorded_at,
            status: session.session_status === "active" ? "active" : "offline"
        });
    }

    calculateDistanceKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;

        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) *
                Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) *
                Math.sin(dLon / 2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    async checkMaintenanceNotification(truckId) {
        try {
            await this.ensureWmoNotificationsTableSafe();

            const [truckRows] = await db.query(
                `
                SELECT id, truck_name, total_distance_km, maintenance_threshold_km
                FROM trucks
                WHERE id = ?
                `,
                [truckId]
            );

            if (truckRows.length === 0) return;

            const truck = truckRows[0];

            if (Number(truck.total_distance_km || 0) < Number(truck.maintenance_threshold_km || 0)) {
                return;
            }

            const [existing] = await db.query(
                `
                SELECT id
                FROM notifications
                WHERE type = 'maintenance'
                  AND message LIKE ?
                  AND DATE(createdAt) = CURDATE()
                LIMIT 1
                `,
                [`%Truck ${truck.truck_name}%`]
            );

            if (existing.length > 0) return;

            await db.query(
                `
                INSERT INTO notifications (type, title, message, isRead)
                VALUES (?, ?, ?, 0)
                `,
                [
                    "maintenance",
                    "Maintenance Required",
                    `Truck ${truck.truck_name} reached ${Number(truck.total_distance_km || 0).toFixed(2)} km`
                ]
            );
        } catch (error) {
            console.error("checkMaintenanceNotification warning:", error);
        }
    }


    async upsertLastLocationWithConnection(connection, data) {
        const {
            truck_id,
            session_id,
            latitude,
            longitude,
            speed = null,
            accuracy = null,
            heading = null,
            altitude = null,
            recorded_at = null,
            status = "active"
        } = data;

        const manilaNow = this.getManilaNowDateTime();
        const lastUpdatedAt = recorded_at || manilaNow;

        const sql = `
            INSERT INTO truck_last_locations (
                truck_id,
                session_id,
                latitude,
                longitude,
                speed,
                accuracy,
                heading,
                altitude,
                last_updated_at,
                status,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                session_id = VALUES(session_id),
                latitude = VALUES(latitude),
                longitude = VALUES(longitude),
                speed = VALUES(speed),
                accuracy = VALUES(accuracy),
                heading = VALUES(heading),
                altitude = VALUES(altitude),
                last_updated_at = VALUES(last_updated_at),
                status = VALUES(status),
                updated_at = VALUES(updated_at)
        `;

        await connection.query(sql, [
            truck_id,
            session_id,
            latitude,
            longitude,
            speed,
            accuracy,
            heading,
            altitude,
            lastUpdatedAt,
            status,
            manilaNow
        ]);
    }

    async upsertLastLocation(data) {
        return this.upsertLastLocationWithConnection(db, data);
    }

    normalizeTrackingDeviceStatus(value) {
        const cleaned = this.cleanText(value).toLowerCase();

        if (
            cleaned === "gps_off" ||
            cleaned === "tracking_off" ||
            cleaned === "permission_missing" ||
            cleaned === "no_permission" ||
            cleaned === "off"
        ) {
            return "gps_off";
        }

        if (
            cleaned === "sync_pending" ||
            cleaned === "weak_signal" ||
            cleaned === "pending" ||
            cleaned === "offline"
        ) {
            return "sync_pending";
        }

        if (cleaned === "active" || cleaned === "live" || cleaned === "on" || cleaned === "synced") {
            return "active";
        }

        return "sync_pending";
    }


    async updateTrackingDeviceStatus(sessionId, data = {}) {
        await this.ensureTrackingSessionReportColumns();

        const statusKey = this.normalizeTrackingDeviceStatus(
            data.tracking_status_key ||
            data.gps_status ||
            data.sync_status ||
            data.status
        );

        const source = this.cleanText(data.source || data.sync_source || "mobile");
        const manilaNow = this.getManilaNowDateTime();

        const [sessionRows] = await db.query(
            `
            SELECT id, truck_id, enforcer_name, session_status
            FROM truck_tracking_sessions
            WHERE id = ?
            LIMIT 1
            `,
            [sessionId]
        );

        if (sessionRows.length === 0) {
            throw new Error("Tracking session not found");
        }

        const session = sessionRows[0];

        const [lastLocationRows] = await db.query(
            `
            SELECT status
            FROM truck_last_locations
            WHERE session_id = ?
            LIMIT 1
            `,
            [sessionId]
        );

        const previousStatusKey = lastLocationRows.length > 0
            ? this.normalizeTrackingDeviceStatus(lastLocationRows[0].status)
            : "";

        await db.query(
            `
            UPDATE truck_tracking_sessions
            SET
                last_device_status = ?,
                last_device_status_at = ?,
                updated_at = ?
            WHERE id = ?
            `,
            [statusKey, manilaNow, manilaNow, sessionId]
        );

        /*
          Update existing last-location row. If there is no row yet,
          /tracking/active still shows the active session as GPS off because
          there are no live route points.
        */
        await db.query(
            `
            UPDATE truck_last_locations
            SET status = ?,
                updated_at = ?
            WHERE session_id = ?
            `,
            [statusKey, manilaNow, sessionId]
        );

        let notification = null;

        if (session.session_status === "active") {
            if (statusKey === "active" && previousStatusKey !== "active") {
                notification = await this.createGpsTrackingNotification("on", {
                    truck_id: session.truck_id,
                    enforcer_name: session.enforcer_name || data.enforcer_name || "",
                    session_id: sessionId
                });
            }

            if (statusKey === "gps_off" && previousStatusKey !== "gps_off") {
                notification = await this.createGpsTrackingNotification("off", {
                    truck_id: session.truck_id,
                    enforcer_name: session.enforcer_name || data.enforcer_name || "",
                    session_id: sessionId
                });
            }
        }

        await this.autoStopExpiredSessions();

        return {
            success: true,
            message: `Tracking device status updated to ${statusKey}.`,
            tracking_status_key: statusKey,
            gps_status: statusKey === "gps_off" ? "off" : "on",
            source,
            truck_id: session.truck_id,
            previous_tracking_status_key: previousStatusKey || null,
            notification
        };
    }


    async getActiveTrucks() {
        this.requestAutoStopCheck();

        const manilaNow = this.getManilaNowDateTime();

        const sql = `
            SELECT
                tts.id AS session_id,
                tts.truck_id,
                tts.enforcer_id,
                tts.enforcer_name,
                tts.device_id,
                tts.session_status,
                tts.started_at,
                tts.shift_end_time,
                tts.effective_shift_end_time,
                tts.last_updated_at,
                tts.last_device_status,
                tts.last_device_status_at,
                tts.session_distance_km,
                tll.latitude,
                tll.longitude,
                tll.speed,
                tll.accuracy,
                tll.heading,
                tll.altitude,
                CONCAT(
                    DATE_FORMAT(tll.last_updated_at, '%Y-%m-%dT%H:%i:%s'),
                    '+08:00'
                ) AS location_last_updated,
                tll.status AS last_location_status,
                TIMESTAMPDIFF(SECOND, tll.last_updated_at, current_time_ref.manila_now) AS last_sync_age_seconds,
                CASE
                    WHEN tts.session_status = 'active'
                         AND tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 30 SECOND)
                    THEN 'active'
                    ELSE 'offline'
                END AS truck_status,
                CASE
                    WHEN tts.session_status <> 'active'
                    THEN 'stopped'

                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'gps_off'

                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('sync_pending', 'weak_signal')
                    THEN 'sync_pending'

                    WHEN tll.last_updated_at IS NULL
                    THEN 'gps_off'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 60 SECOND)
                    THEN 'active'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 5 MINUTE)
                    THEN 'sync_pending'

                    ELSE 'gps_off'
                END AS tracking_status_key,
                CASE
                    WHEN tts.session_status <> 'active'
                    THEN 'Stopped'

                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'GPS off'

                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('sync_pending', 'weak_signal')
                    THEN 'Sync pending'

                    WHEN tll.last_updated_at IS NULL
                    THEN 'GPS off'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 60 SECOND)
                    THEN 'Live'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 5 MINUTE)
                    THEN 'Sync pending'

                    ELSE 'GPS off'
                END AS tracking_status_label,
                CASE
                    WHEN tts.session_status <> 'active'
                    THEN 'Tracking session has ended.'

                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'GPS tracking is turned off. No live route points are being recorded.'

                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('sync_pending', 'weak_signal')
                    THEN 'GPS may still be on, but mobile signal is weak. Route points will continue after the phone syncs.'

                    WHEN tll.last_updated_at IS NULL
                    THEN 'GPS tracking is turned off or no live GPS points are being recorded.'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 60 SECOND)
                    THEN 'Live GPS signal is syncing normally.'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 5 MINUTE)
                    THEN 'GPS may still be on, but mobile signal is weak. Route points will continue after the phone syncs.'

                    ELSE 'GPS tracking is turned off or no live GPS points are being recorded.'
                END AS tracking_status_description,
                CASE
                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'off'

                    WHEN tll.last_updated_at IS NULL
                    THEN 'off'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 5 MINUTE)
                    THEN 'on'

                    ELSE 'off'
                END AS gps_status,
                CASE
                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'not_syncing'

                    WHEN LOWER(COALESCE(tll.status, tts.last_device_status, '')) IN ('sync_pending', 'weak_signal')
                    THEN 'pending'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 60 SECOND)
                    THEN 'synced'

                    WHEN tll.last_updated_at >= DATE_SUB(current_time_ref.manila_now, INTERVAL 5 MINUTE)
                    THEN 'pending'

                    ELSE 'not_syncing'
                END AS sync_status
            FROM truck_tracking_sessions tts
            LEFT JOIN truck_last_locations tll
                ON tts.id = tll.session_id
            CROSS JOIN (SELECT ? AS manila_now) current_time_ref
            WHERE tts.session_status = 'active'
            ORDER BY tll.last_updated_at DESC, tts.started_at DESC
        `;

        const [rows] = await db.query(sql, [manilaNow]);
        return rows;
    }

    async getRouteHistoryBySession(sessionId) {
        await this.ensureOfflineTrackingColumns();

        const sessionSql = `
            SELECT *
            FROM truck_tracking_sessions
            WHERE id = ?
            LIMIT 1
        `;

        const [sessionRows] = await db.query(sessionSql, [sessionId]);

        if (sessionRows.length === 0) {
            throw new Error("Tracking session not found");
        }

        const logsSql = `
            SELECT
                id,
                session_id,
                truck_id,
                latitude,
                longitude,
                speed,
                accuracy,
                heading,
                altitude,
                local_point_id,
                sync_source,
                recorded_at
            FROM truck_location_logs
            WHERE session_id = ?
            ORDER BY recorded_at ASC
        `;

        const [logRows] = await db.query(logsSql, [sessionId]);

        return {
            session: sessionRows[0],
            route_logs: logRows
        };
    }

    async getTruckLatestSession(truckId) {
        const sql = `
            SELECT *
            FROM truck_tracking_sessions
            WHERE truck_id = ?
            ORDER BY started_at DESC
            LIMIT 1
        `;

        const [rows] = await db.query(sql, [truckId]);

        if (rows.length === 0) {
            throw new Error("No tracking session found for this truck");
        }

        return rows[0];
    }

    buildTrackingReportStatus(row = {}) {
        const rawSessionStatus = this.cleanText(row.session_status || row.status || "").toLowerCase();
        const sessionStatus = rawSessionStatus === "auto_wmo_stop"
            ? "auto_stopped"
            : (["manual_stopped", "manual_wmo_stop", "wmo_stop"].includes(rawSessionStatus)
                ? "stopped"
                : rawSessionStatus);
        const routeCount = Number(row.route_logs_count || row.route_count || 0);
        const distanceKm = Number(row.session_distance_km || row.total_distance_km || 0);
        const hasRoute = routeCount > 0 || distanceKm > 0;
        const hasMeasuredDistance = distanceKm > 0;

        const rawFinalStatus = this.cleanText(
            row.final_tracking_status_key ||
            row.last_device_status ||
            row.last_location_status ||
            row.tracking_status_key ||
            row.final_gps_status ||
            ""
        );

        let trackingStatusKey = rawFinalStatus
            ? this.normalizeTrackingDeviceStatus(rawFinalStatus)
            : "";

        /*
          Important:
          Do not label a report as "No Route" when the session has distance.
          Older rows may have route_logs_count = 0 but still have session_distance_km
          because the distance was recalculated or saved from older logic.
        */
        if (!trackingStatusKey) {
            trackingStatusKey = hasRoute ? "active" : "gps_off";
        }

        let reportStatusKey = "completed";
        let reportStatusLabel = "Completed Normally";
        let reportStatusTone = "completed";
        let gpsConditionLabel = "GPS Active / Route Recorded";
        let reportStatusDescription = this.cleanText(row.final_tracking_status_description);
        let routeConditionLabel = hasRoute
            ? (routeCount > 0
                ? `${routeCount} route point${routeCount === 1 ? "" : "s"}`
                : `${distanceKm.toFixed(2)} km route recorded`)
            : "No route points";

        if (trackingStatusKey === "gps_off") {
            gpsConditionLabel = hasRoute ? "GPS Off / Partial Route" : "GPS Off / No GPS Route";
        } else if (trackingStatusKey === "sync_pending") {
            gpsConditionLabel = hasRoute ? "Sync Pending / Route Recorded" : "Sync Pending / No Route";
        } else if (!hasRoute) {
            gpsConditionLabel = "GPS Active / No Route Yet";
        }

        if (!reportStatusDescription) {
            if (trackingStatusKey === "gps_off" && hasRoute) {
                reportStatusDescription = "The session ended with GPS off, but earlier route data was recorded.";
            } else if (trackingStatusKey === "gps_off" && !hasRoute) {
                reportStatusDescription = "The session ended with GPS off and no route points were recorded.";
            } else if (trackingStatusKey === "sync_pending") {
                reportStatusDescription = hasRoute
                    ? "The route was recorded, but the mobile signal had sync delays during the shift."
                    : "The mobile signal was weak or pending and no route points were recorded.";
            } else {
                reportStatusDescription = hasRoute
                    ? "Tracking session was completed with route data recorded."
                    : "Tracking session completed, but no route points were recorded.";
            }
        }

        if (sessionStatus === "active") {
            if (trackingStatusKey === "gps_off") {
                reportStatusKey = hasRoute ? "active_gps_off_partial_route" : "active_gps_off_no_route";
                reportStatusLabel = hasRoute ? "Active · GPS Off" : "Active · No GPS Route";
                reportStatusTone = "gps-off";
            } else if (trackingStatusKey === "sync_pending") {
                reportStatusKey = hasRoute ? "active_sync_pending_route" : "active_sync_pending_no_route";
                reportStatusLabel = "Active · Sync Pending";
                reportStatusTone = "sync-pending";
            } else {
                reportStatusKey = hasRoute ? "active_live_route" : "active_live_no_route";
                reportStatusLabel = hasRoute ? "Active · Live Route" : "Active · Live";
                reportStatusTone = "active";
            }
        } else if (sessionStatus === "auto_stopped") {
            if (trackingStatusKey === "gps_off") {
                reportStatusKey = hasRoute ? "shift_completed_gps_off_partial_route" : "shift_completed_no_gps_route";
                reportStatusLabel = hasRoute ? "Shift Completed · GPS Off" : "Shift Completed · No GPS Route";
                reportStatusTone = "gps-off";
            } else if (trackingStatusKey === "sync_pending") {
                reportStatusKey = hasRoute ? "shift_completed_synced_route" : "shift_completed_sync_pending_no_route";
                reportStatusLabel = hasRoute ? "Shift Completed · Synced Route" : "Shift Completed · Sync Pending";
                reportStatusTone = "sync-pending";
            } else if (hasRoute) {
                reportStatusKey = "shift_completed_route_recorded";
                reportStatusLabel = "Shift Completed · Route Recorded";
                reportStatusTone = "completed";
            } else {
                reportStatusKey = "shift_completed_no_route";
                reportStatusLabel = "Shift Completed · No Route";
                reportStatusTone = "neutral";
            }
        } else if (sessionStatus === "stopped") {
            if (trackingStatusKey === "gps_off") {
                reportStatusKey = hasRoute ? "stopped_gps_off_partial_route" : "stopped_no_gps_route";
                reportStatusLabel = hasRoute ? "Stopped · GPS Off" : "Stopped · No GPS Route";
                reportStatusTone = "gps-off";
            } else if (trackingStatusKey === "sync_pending") {
                reportStatusKey = hasRoute ? "stopped_sync_pending_route" : "stopped_sync_pending_no_route";
                reportStatusLabel = "Stopped · Sync Pending";
                reportStatusTone = "sync-pending";
            } else if (hasRoute) {
                reportStatusKey = "stopped_route_recorded";
                reportStatusLabel = "Manually Stopped · Route Recorded";
                reportStatusTone = "stopped";
            } else {
                reportStatusKey = "stopped_no_route";
                reportStatusLabel = "Manually Stopped · No Route";
                reportStatusTone = "neutral";
            }
        } else if (sessionStatus) {
            reportStatusKey = sessionStatus;
            reportStatusLabel = sessionStatus.replace(/_/g, " ");
            reportStatusTone = "neutral";
        }

        return {
            report_status_key: reportStatusKey,
            report_status_label: reportStatusLabel,
            report_status_tone: reportStatusTone,
            gps_condition_label: gpsConditionLabel,
            tracking_status_key: trackingStatusKey,
            route_logs_count: routeCount,
            route_condition_label: routeConditionLabel,
            has_route_recorded: hasRoute ? 1 : 0,
            has_measured_distance: hasMeasuredDistance ? 1 : 0,
            report_status_description: reportStatusDescription
        };
    }

    enrichTrackingReportRow(row = {}) {
        const statusMeta = this.buildTrackingReportStatus(row);

        return {
            ...row,
            ...statusMeta
        };
    }

    async getTrackingReports() {
        await this.autoStopExpiredSessions();
        await this.backfillTrackingCompletedNotifications(100);
        await this.ensureTrackingSessionReportColumns();

        const sql = `
            SELECT
                tts.id,
                tts.truck_id,
                tts.enforcer_id,
                tts.enforcer_name,
                tts.device_id,
                tts.session_status,
                DATE_FORMAT(tts.started_at, '%Y-%m-%d %H:%i:%s') AS started_at,
                DATE_FORMAT(tts.ended_at, '%Y-%m-%d %H:%i:%s') AS ended_at,
                DATE_FORMAT(tts.shift_end_time, '%Y-%m-%d %H:%i:%s') AS shift_end_time,
                DATE_FORMAT(tts.effective_shift_end_time, '%Y-%m-%d %H:%i:%s') AS effective_shift_end_time,
                tts.start_latitude,
                tts.start_longitude,
                tts.end_latitude,
                tts.end_longitude,
                tts.last_latitude,
                tts.last_longitude,
                DATE_FORMAT(tts.last_updated_at, '%Y-%m-%d %H:%i:%s') AS last_updated_at,
                tts.last_device_status,
                DATE_FORMAT(tts.last_device_status_at, '%Y-%m-%d %H:%i:%s') AS last_device_status_at,
                tts.final_tracking_status_key,
                tts.final_gps_status,
                tts.final_sync_status,
                tts.final_tracking_status_description,
                tts.session_distance_km,
                COALESCE(route_counts.route_logs_count, 0) AS route_logs_count
            FROM truck_tracking_sessions tts
            LEFT JOIN (
                SELECT session_id, COUNT(*) AS route_logs_count
                FROM truck_location_logs
                GROUP BY session_id
            ) route_counts
                ON route_counts.session_id = tts.id
            ORDER BY tts.started_at DESC, tts.id DESC
        `;

        const [rows] = await db.query(sql);
        return (rows || []).map((row) => this.enrichTrackingReportRow(row));
    }

    async getTrackingReportDetails(sessionId) {
        await this.autoStopExpiredSessions();
        await this.backfillTrackingCompletedNotifications(100);
        await this.ensureOfflineTrackingColumns();
        await this.ensureTrackingSessionReportColumns();

        const sessionSql = `
            SELECT
                tts.*,
                DATE_FORMAT(tts.started_at, '%Y-%m-%d %H:%i:%s') AS started_at,
                DATE_FORMAT(tts.ended_at, '%Y-%m-%d %H:%i:%s') AS ended_at,
                DATE_FORMAT(tts.shift_end_time, '%Y-%m-%d %H:%i:%s') AS shift_end_time,
                DATE_FORMAT(tts.effective_shift_end_time, '%Y-%m-%d %H:%i:%s') AS effective_shift_end_time,
                DATE_FORMAT(tts.last_updated_at, '%Y-%m-%d %H:%i:%s') AS last_updated_at,
                DATE_FORMAT(tts.last_device_status_at, '%Y-%m-%d %H:%i:%s') AS last_device_status_at,
                COALESCE(route_counts.route_logs_count, 0) AS route_logs_count
            FROM truck_tracking_sessions tts
            LEFT JOIN (
                SELECT session_id, COUNT(*) AS route_logs_count
                FROM truck_location_logs
                GROUP BY session_id
            ) route_counts
                ON route_counts.session_id = tts.id
            WHERE tts.id = ?
            LIMIT 1
        `;

        const [sessionRows] = await db.query(sessionSql, [sessionId]);

        if (sessionRows.length === 0) {
            throw new Error("Tracking session not found");
        }

        const logsSql = `
            SELECT
                id,
                session_id,
                truck_id,
                latitude,
                longitude,
                speed,
                accuracy,
                heading,
                altitude,
                local_point_id,
                sync_source,
                DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s') AS recorded_at
            FROM truck_location_logs
            WHERE session_id = ?
            ORDER BY recorded_at ASC
        `;

        const [logRows] = await db.query(logsSql, [sessionId]);
        const session = this.enrichTrackingReportRow({
            ...sessionRows[0],
            route_logs_count: Array.isArray(logRows) ? logRows.length : 0
        });

        return {
            session,
            route_logs: logRows
        };
    }
}

const trackingService = new TrackingService();

module.exports = trackingService;
module.exports.TrackingService = TrackingService;
module.exports.TrackingStartEligibilityError = TrackingStartEligibilityError;
module.exports.TrackingEndOperationsError = TrackingEndOperationsError;
module.exports.WMO_GEOFENCE = WMO_GEOFENCE;
