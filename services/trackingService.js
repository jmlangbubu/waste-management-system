const db = require("../config/dbPromise");

class TrackingService {
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
            SELECT id, truck_id, session_status
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

        return {
            success: true,
            message: "Tracking session stopped successfully",
            truck_id: session.truck_id
        };
    }

    async addLocationLog(sessionId, data) {
        await this.autoStopExpiredSessions();

        const {
            latitude,
            longitude,
            speed = null,
            accuracy = null,
            heading = null,
            altitude = null
        } = data;

        if (latitude == null || longitude == null) {
            throw new Error("latitude and longitude are required");
        }

        const sessionSql = `
            SELECT id, truck_id, session_status, shift_end_time, last_latitude, last_longitude
            FROM truck_tracking_sessions
            WHERE id = ?
            LIMIT 1
        `;

        const [sessionRows] = await db.query(sessionSql, [sessionId]);

        if (sessionRows.length === 0) {
            throw new Error("Tracking session not found");
        }

        const session = sessionRows[0];

        if (session.session_status !== "active") {
            throw new Error("Tracking session is no longer active");
        }

        const now = new Date();
        const shiftEnd = new Date(session.shift_end_time);

        if (now >= shiftEnd) {
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
                recorded_at,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `;

        await db.query(logSql, [
            sessionId,
            session.truck_id,
            latitude,
            longitude,
            speed,
            accuracy,
            heading,
            altitude
        ]);

        const prevLat = session.last_latitude;
        const prevLng = session.last_longitude;

        if (prevLat != null && prevLng != null) {
            const distance = this.calculateDistanceKm(
                Number(prevLat),
                Number(prevLng),
                Number(latitude),
                Number(longitude)
            );

            await db.query(
                `
                UPDATE truck_tracking_sessions
                SET session_distance_km = COALESCE(session_distance_km, 0) + ?
                WHERE id = ?
                `,
                [distance, sessionId]
            );

            await db.query(
                `
                UPDATE trucks
                SET total_distance_km = COALESCE(total_distance_km, 0) + ?
                WHERE id = ?
                `,
                [distance, session.truck_id]
            );

            await this.checkMaintenanceNotification(session.truck_id);
        }

        const sessionUpdateSql = `
            UPDATE truck_tracking_sessions
            SET
                last_latitude = ?,
                last_longitude = ?,
                last_updated_at = NOW(),
                updated_at = NOW()
            WHERE id = ?
        `;

        await db.query(sessionUpdateSql, [latitude, longitude, sessionId]);

        await this.upsertLastLocation({
            truck_id: session.truck_id,
            session_id: sessionId,
            latitude,
            longitude,
            speed,
            accuracy,
            heading,
            altitude,
            status: "active"
        });

        return {
            success: true,
            message: "Location recorded successfully"
        };
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
            WHERE truck_id = ?
              AND type = 'maintenance'
              AND DATE(created_at) = CURDATE()
            `,
            [truck.id]
        );

        if (existing.length > 0) return;

        await db.query(
            `
            INSERT INTO notifications (title, message, type, truck_id, created_at)
            VALUES (?, ?, ?, ?, NOW())
            `,
            [
                "Maintenance Required",
                `Truck ${truck.truck_name} reached ${Number(truck.total_distance_km || 0).toFixed(2)} km`,
                "maintenance",
                truck.id
            ]
        );
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

    async getActiveTrucks() {
        await this.autoStopExpiredSessions();

        const sql = `
            SELECT
                tts.id AS session_id,
                tts.truck_id,
                tts.enforcer_id,
                tts.enforcer_name,
                tts.device_id,
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
                CASE
                    WHEN tts.session_status = 'active'
                         AND tll.last_updated_at >= (NOW() - INTERVAL 30 SECOND)
                    THEN 'active'
                    ELSE 'offline'
                END AS truck_status
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