const db = require("../config/dbPromise");

class TrackingService {
    cleanText(value) {
        if (value === null || value === undefined) return "";

        const text = String(value).trim();

        if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
            return "";
        }

        return text;
    }

    normalizeDateTime(value) {
        const cleaned = this.cleanText(value);

        if (!cleaned) {
            return new Date();
        }

        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cleaned)) {
            return cleaned;
        }

        if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) {
            return cleaned.replace("T", " ").replace(/\.\d{3}Z?$/, "").replace(/Z$/, "");
        }

        const parsed = new Date(cleaned);

        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString().slice(0, 19).replace("T", " ");
        }

        return new Date();
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

    async autoStopExpiredSessions() {
        const sql = `
            UPDATE truck_tracking_sessions
            SET 
                session_status = 'auto_stopped',
                ended_at = IFNULL(ended_at, NOW()),
                updated_at = NOW()
            WHERE session_status = 'active'
              AND shift_end_time <= NOW()
        `;

        await db.query(sql);

        const offlineSql = `
            UPDATE truck_last_locations tll
            INNER JOIN truck_tracking_sessions tts ON tll.session_id = tts.id
            SET 
                tll.status = 'offline',
                tll.updated_at = NOW()
            WHERE tts.session_status IN ('stopped', 'auto_stopped')
        `;

        await db.query(offlineSql);
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

        if (!columnSet.has("createdAt")) {
            alters.push("ADD COLUMN createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
        }

        if (alters.length > 0) {
            try {
                await db.query(`
                    ALTER TABLE notifications
                    ${alters.join(",\\n                    ")}
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

            await db.query(
                `
                INSERT INTO notifications (
                    type,
                    title,
                    message,
                    isRead
                )
                VALUES (?, ?, ?, 0)
                `,
                [
                    "tracking",
                    title,
                    message
                ]
            );

            return {
                title,
                message,
                type: "tracking",
                truck_id: truckId,
                session_id: sessionId
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


    async startTrackingSession(data) {
        await this.autoStopExpiredSessions();

        const {
            truck_id,
            enforcer_id = null,
            enforcer_name = null,
            device_id = null,
            shift_end_time,
            start_latitude = null,
            start_longitude = null
        } = data;

        if (!truck_id || !shift_end_time) {
            throw new Error("truck_id and shift_end_time are required");
        }

        const checkActiveSql = `
            SELECT id 
            FROM truck_tracking_sessions
            WHERE truck_id = ?
              AND session_status = 'active'
            LIMIT 1
        `;

        const [activeRows] = await db.query(checkActiveSql, [truck_id]);

        if (activeRows.length > 0) {
            await this.createGpsTrackingNotification("on", {
                truck_id,
                enforcer_id,
                enforcer_name,
                session_id: activeRows[0].id
            });

            return {
                alreadyActive: true,
                sessionId: activeRows[0].id
            };
        }

        const insertSql = `
            INSERT INTO truck_tracking_sessions (
                truck_id,
                enforcer_id,
                enforcer_name,
                device_id,
                session_status,
                started_at,
                shift_end_time,
                start_latitude,
                start_longitude,
                last_latitude,
                last_longitude,
                last_updated_at,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, 'active', NOW(), ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
        `;

        const [result] = await db.query(insertSql, [
            truck_id,
            enforcer_id,
            enforcer_name,
            device_id,
            shift_end_time,
            start_latitude,
            start_longitude,
            start_latitude,
            start_longitude
        ]);

        const sessionId = result.insertId;

        if (start_latitude != null && start_longitude != null) {
            await this.upsertLastLocation({
                truck_id,
                session_id: sessionId,
                latitude: start_latitude,
                longitude: start_longitude,
                speed: null,
                accuracy: null,
                heading: null,
                altitude: null,
                status: "active"
            });
        }

        await this.createGpsTrackingNotification("on", {
            truck_id,
            enforcer_id,
            enforcer_name,
            session_id: sessionId
        });

        return {
            alreadyActive: false,
            sessionId
        };
    }

    async stopTrackingSession(sessionId, data = {}) {
        const {
            end_latitude = null,
            end_longitude = null,
            stop_type = "stopped"
        } = data;

        const allowedStopType = ["stopped", "auto_stopped"].includes(stop_type)
            ? stop_type
            : "stopped";

        const getSessionSql = `
            SELECT id, truck_id, enforcer_name, session_status
            FROM truck_tracking_sessions
            WHERE id = ?
            LIMIT 1
        `;

        const [rows] = await db.query(getSessionSql, [sessionId]);

        if (rows.length === 0) {
            throw new Error("Tracking session not found");
        }

        const session = rows[0];

        if (session.session_status !== "active") {
            return {
                success: true,
                message: "Session already stopped",
                truck_id: session.truck_id
            };
        }

        const updateSql = `
            UPDATE truck_tracking_sessions
            SET
                session_status = ?,
                ended_at = NOW(),
                end_latitude = ?,
                end_longitude = ?,
                last_latitude = COALESCE(?, last_latitude),
                last_longitude = COALESCE(?, last_longitude),
                last_updated_at = NOW(),
                updated_at = NOW()
            WHERE id = ?
        `;

        await db.query(updateSql, [
            allowedStopType,
            end_latitude,
            end_longitude,
            end_latitude,
            end_longitude,
            sessionId
        ]);

        const updateLastLocationSql = `
            UPDATE truck_last_locations
            SET
                status = 'offline',
                updated_at = NOW()
            WHERE session_id = ?
        `;

        await db.query(updateLastLocationSql, [sessionId]);

        await this.createGpsTrackingNotification("off", {
            truck_id: session.truck_id,
            enforcer_name: session.enforcer_name || "",
            session_id: sessionId
        });

        return {
            success: true,
            message: "Tracking session stopped successfully",
            truck_id: session.truck_id
        };
    }

    async addLocationLog(sessionId, data) {
        const result = await this.addSingleLocationLog(sessionId, data);

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
            .filter((item) => item && item.latitude !== undefined && item.longitude !== undefined)
            .sort((a, b) => {
                const aTime = new Date(a.recorded_at || a.recordedAt || 0).getTime();
                const bTime = new Date(b.recorded_at || b.recordedAt || 0).getTime();
                return aTime - bTime;
            });

        let insertedCount = 0;
        let duplicateCount = 0;
        const syncedLocalPointIds = [];

        for (const point of sortedLocations) {
            const result = await this.addSingleLocationLog(sessionId, point);

            if (result.duplicate) {
                duplicateCount++;
            } else {
                insertedCount++;
            }

            if (result.local_point_id) {
                syncedLocalPointIds.push(result.local_point_id);
            }
        }

        return {
            success: true,
            message: "Location batch synced successfully",
            inserted_count: insertedCount,
            duplicate_count: duplicateCount,
            synced_local_point_ids: syncedLocalPointIds
        };
    }

    async addSingleLocationLog(sessionId, data) {
        await this.autoStopExpiredSessions();
        await this.ensureOfflineTrackingColumns();

        const {
            latitude,
            longitude,
            speed = null,
            accuracy = null,
            heading = null,
            altitude = null
        } = data;

        const localPointId = this.cleanText(data.local_point_id || data.localPointId);
        const recordedAt = this.normalizeDateTime(data.recorded_at || data.recordedAt);

        if (latitude == null || longitude == null) {
            throw new Error("latitude and longitude are required");
        }

        const sessionSql = `
            SELECT id, truck_id, session_status, shift_end_time, ended_at
            FROM truck_tracking_sessions
            WHERE id = ?
            LIMIT 1
        `;

        const [sessionRows] = await db.query(sessionSql, [sessionId]);

        if (sessionRows.length === 0) {
            throw new Error("Tracking session not found");
        }

        const session = sessionRows[0];

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

        const shiftEnd = session.shift_end_time ? new Date(session.shift_end_time) : null;
        const endedAt = session.ended_at ? new Date(session.ended_at) : null;
        const pointTime = recordedAt instanceof Date ? recordedAt : new Date(recordedAt);

        const isHistoricalPointBeforeEnd =
            localPointId &&
            shiftEnd &&
            !Number.isNaN(pointTime.getTime()) &&
            pointTime <= shiftEnd;

        const isHistoricalPointBeforeStoppedTime =
            localPointId &&
            endedAt &&
            !Number.isNaN(pointTime.getTime()) &&
            pointTime <= endedAt;

        if (
            session.session_status !== "active" &&
            !isHistoricalPointBeforeEnd &&
            !isHistoricalPointBeforeStoppedTime
        ) {
            throw new Error("Tracking session is no longer active");
        }

        const now = new Date();

        if (
            session.session_status === "active" &&
            shiftEnd &&
            now >= shiftEnd &&
            !isHistoricalPointBeforeEnd
        ) {
            await this.stopTrackingSession(sessionId, {
                end_latitude: latitude,
                end_longitude: longitude,
                stop_type: "auto_stopped"
            });

            throw new Error("Shift already ended. Session auto-stopped.");
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
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
            recordedAt
        ]);

        await this.recalculateSessionDistanceAndLatestLocation(sessionId);

        return {
            duplicate: false,
            local_point_id: localPointId || null
        };
    }

    async recalculateSessionDistanceAndLatestLocation(sessionId) {
        const sessionSql = `
            SELECT id, truck_id, session_status
            FROM truck_tracking_sessions
            WHERE id = ?
            LIMIT 1
        `;

        const [sessionRows] = await db.query(sessionSql, [sessionId]);

        if (sessionRows.length === 0) return;

        const session = sessionRows[0];

        const logsSql = `
            SELECT latitude, longitude, speed, accuracy, heading, altitude, recorded_at
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
                updated_at = NOW()
            WHERE id = ?
            `,
            [
                Number(totalDistanceKm.toFixed(4)),
                latest.latitude,
                latest.longitude,
                latest.recorded_at,
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

    async upsertLastLocation(data) {
        const {
            truck_id,
            session_id,
            latitude,
            longitude,
            speed = null,
            accuracy = null,
            heading = null,
            altitude = null,
            status = "active"
        } = data;

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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())
            ON DUPLICATE KEY UPDATE
                session_id = VALUES(session_id),
                latitude = VALUES(latitude),
                longitude = VALUES(longitude),
                speed = VALUES(speed),
                accuracy = VALUES(accuracy),
                heading = VALUES(heading),
                altitude = VALUES(altitude),
                last_updated_at = NOW(),
                status = VALUES(status),
                updated_at = NOW()
        `;

        await db.query(sql, [
            truck_id,
            session_id,
            latitude,
            longitude,
            speed,
            accuracy,
            heading,
            altitude,
            status
        ]);
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
        const statusKey = this.normalizeTrackingDeviceStatus(
            data.tracking_status_key ||
            data.gps_status ||
            data.sync_status ||
            data.status
        );

        const source = this.cleanText(data.source || data.sync_source || "mobile");

        const [sessionRows] = await db.query(
            `
            SELECT id, truck_id, session_status
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

        await db.query(
            `
            UPDATE truck_tracking_sessions
            SET updated_at = NOW()
            WHERE id = ?
            `,
            [sessionId]
        );

        /*
          Only update existing last-location row.
          If there is no row yet, /tracking/active will still show GPS off
          because no GPS point exists for the active session.
        */
        await db.query(
            `
            UPDATE truck_last_locations
            SET status = ?,
                updated_at = NOW()
            WHERE session_id = ?
            `,
            [statusKey, sessionId]
        );

        return {
            success: true,
            message: `Tracking device status updated to ${statusKey}.`,
            tracking_status_key: statusKey,
            gps_status: statusKey === "gps_off" ? "off" : "on",
            source,
            truck_id: session.truck_id
        };
    }

    async getActiveTrucks() {
        await this.autoStopExpiredSessions();

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
                tts.last_updated_at,
                tts.session_distance_km,
                tll.latitude,
                tll.longitude,
                tll.speed,
                tll.accuracy,
                tll.heading,
                tll.altitude,
                tll.last_updated_at AS location_last_updated,
                tll.status AS last_location_status,
                TIMESTAMPDIFF(SECOND, tll.last_updated_at, NOW()) AS last_sync_age_seconds,
                CASE
                    WHEN tts.session_status = 'active'
                         AND tll.last_updated_at >= (NOW() - INTERVAL 30 SECOND)
                    THEN 'active'
                    ELSE 'offline'
                END AS truck_status,
                CASE
                    WHEN tts.session_status <> 'active'
                    THEN 'stopped'

                    WHEN LOWER(COALESCE(tll.status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'gps_off'

                    WHEN LOWER(COALESCE(tll.status, '')) IN ('sync_pending', 'weak_signal')
                    THEN 'sync_pending'

                    WHEN tll.last_updated_at IS NULL
                    THEN 'gps_off'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 60 SECOND)
                    THEN 'active'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 5 MINUTE)
                    THEN 'sync_pending'

                    ELSE 'gps_off'
                END AS tracking_status_key,
                CASE
                    WHEN tts.session_status <> 'active'
                    THEN 'Stopped'

                    WHEN LOWER(COALESCE(tll.status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'GPS off'

                    WHEN LOWER(COALESCE(tll.status, '')) IN ('sync_pending', 'weak_signal')
                    THEN 'Sync pending'

                    WHEN tll.last_updated_at IS NULL
                    THEN 'GPS off'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 60 SECOND)
                    THEN 'Live'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 5 MINUTE)
                    THEN 'Sync pending'

                    ELSE 'GPS off'
                END AS tracking_status_label,
                CASE
                    WHEN tts.session_status <> 'active'
                    THEN 'Tracking session has ended.'

                    WHEN LOWER(COALESCE(tll.status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'GPS tracking is turned off. No live route points are being recorded.'

                    WHEN LOWER(COALESCE(tll.status, '')) IN ('sync_pending', 'weak_signal')
                    THEN 'GPS may still be on, but mobile signal is weak. Route points will continue after the phone syncs.'

                    WHEN tll.last_updated_at IS NULL
                    THEN 'GPS tracking is turned off or no live GPS points are being recorded.'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 60 SECOND)
                    THEN 'Live GPS signal is syncing normally.'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 5 MINUTE)
                    THEN 'GPS may still be on, but mobile signal is weak. Route points will continue after the phone syncs.'

                    ELSE 'GPS tracking is turned off or no live GPS points are being recorded.'
                END AS tracking_status_description,
                CASE
                    WHEN LOWER(COALESCE(tll.status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'off'

                    WHEN tll.last_updated_at IS NULL
                    THEN 'off'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 5 MINUTE)
                    THEN 'on'

                    ELSE 'off'
                END AS gps_status,
                CASE
                    WHEN LOWER(COALESCE(tll.status, '')) IN ('gps_off', 'tracking_off', 'permission_missing')
                    THEN 'not_syncing'

                    WHEN LOWER(COALESCE(tll.status, '')) IN ('sync_pending', 'weak_signal')
                    THEN 'pending'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 60 SECOND)
                    THEN 'synced'

                    WHEN tll.last_updated_at >= (NOW() - INTERVAL 5 MINUTE)
                    THEN 'pending'

                    ELSE 'not_syncing'
                END AS sync_status
            FROM truck_tracking_sessions tts
            LEFT JOIN truck_last_locations tll
                ON tts.id = tll.session_id
            WHERE tts.session_status = 'active'
            ORDER BY tll.last_updated_at DESC
        `;

        const [rows] = await db.query(sql);
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

    async getTrackingReports() {
        const sql = `
            SELECT
                id,
                truck_id,
                enforcer_id,
                enforcer_name,
                device_id,
                session_status,
                started_at,
                ended_at,
                shift_end_time,
                start_latitude,
                start_longitude,
                end_latitude,
                end_longitude,
                last_latitude,
                last_longitude,
                last_updated_at,
                session_distance_km
            FROM truck_tracking_sessions
            ORDER BY started_at DESC
        `;

        const [rows] = await db.query(sql);
        return rows;
    }

    async getTrackingReportDetails(sessionId) {
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
}

module.exports = new TrackingService();
