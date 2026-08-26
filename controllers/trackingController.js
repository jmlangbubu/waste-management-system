const trackingService = require('../services/trackingService');

function buildTrackingNotificationPayload(notification = {}) {
    return {
        ...notification,
        _source: 'tracking',
        type: notification.type || 'tracking',
        createdAt: notification.createdAt || new Date().toISOString()
    };
}

function emitWmoTrackingNotification(req, notification) {
    if (!notification) return;

    try {
        const io = req.app && typeof req.app.get === 'function'
            ? req.app.get('io')
            : null;

        if (!io || typeof io.to !== 'function') {
            return;
        }

        const payload = buildTrackingNotificationPayload(notification);

        /*
          The web notification script already listens to these event names.
          Emitting all three keeps this safe with the existing WMO bell logic
          and avoids touching frontend notification code.
        */
        io.to('wmo').emit('wmo:gps-tracking-notification', payload);
        io.to('wmo').emit('wmo:tracking-notification', payload);
        io.to('wmo').emit('notification:new', payload);
    } catch (error) {
        console.error('emitWmoTrackingNotification warning:', error);
    }
}

exports.startTrackingSession = async (req, res) => {
    try {
        const result = await trackingService.startTrackingSession(req.body);

        emitWmoTrackingNotification(req, result.notification);

        return res.status(200).json({
            success: true,
            message: result.alreadyActive
                ? 'Tracking session already active'
                : 'Tracking session started successfully',
            sessionId: result.sessionId,
            alreadyActive: result.alreadyActive,
            notification: result.notification || null
        });
    } catch (error) {
        console.error('startTrackingSession error:', error);
        const statusCode = Number(error.statusCode) || 500;
        return res.status(statusCode).json({
            success: false,
            message: statusCode >= 500
                ? 'Unable to start the tracking session right now.'
                : error.message || 'Unable to start the tracking session.',
            code: error.code || 'TRACKING_START_FAILED'
        });
    }
};

exports.stopTrackingSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await trackingService.stopTrackingSession(sessionId, req.body);

        emitWmoTrackingNotification(req, result.notification);

        return res.status(200).json({
            success: true,
            message: result.message,
            truck_id: result.truck_id,
            notification: result.notification || null
        });
    } catch (error) {
        console.error('stopTrackingSession error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Failed to stop tracking session'
        });
    }
};

exports.stopTrackingSessionByWebAdmin = async (req, res) => {
    try {
        const result = await trackingService.stopTrackingSessionByWebAdmin(
            req.params.sessionId,
            req.user
        );

        emitWmoTrackingNotification(req, result.notification);

        return res.status(200).json({
            success: true,
            message: result.message,
            truck_id: result.truck_id,
            already_stopped: result.already_stopped === true,
            stopped_by: result.stopped_by,
            notification: result.notification || null
        });
    } catch (error) {
        const statusCode = Number(error.statusCode) || 500;
        const code = error.code || "TRACKING_ADMIN_STOP_FAILED";
        console.warn("stopTrackingSessionByWebAdmin warning:", code);
        return res.status(statusCode).json({
            success: false,
            message: statusCode >= 500
                ? "Unable to stop the tracking session right now."
                : error.message || "Unable to stop the tracking session.",
            code
        });
    }
};

exports.addLocationLog = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await trackingService.addLocationLog(sessionId, req.body);

        return res.status(200).json({
            success: true,
            message: result.message,
            duplicate: result.duplicate || false,
            local_point_id: result.local_point_id || null
        });
    } catch (error) {
        console.error('addLocationLog error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Failed to record location'
        });
    }
};

exports.addLocationLogsBatch = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await trackingService.addLocationLogsBatch(sessionId, req.body);

        return res.status(200).json({
            success: true,
            message: result.message,
            inserted_count: result.inserted_count || 0,
            duplicate_count: result.duplicate_count || 0,
            synced_local_point_ids: result.synced_local_point_ids || []
        });
    } catch (error) {
        console.error('addLocationLogsBatch error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Failed to sync location batch'
        });
    }
};

exports.updateTrackingDeviceStatus = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await trackingService.updateTrackingDeviceStatus(sessionId, req.body);

        emitWmoTrackingNotification(req, result.notification);

        return res.status(200).json({
            success: true,
            message: result.message,
            tracking_status_key: result.tracking_status_key,
            gps_status: result.gps_status,
            notification: result.notification || null
        });
    } catch (error) {
        console.error('updateTrackingDeviceStatus error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Failed to update tracking device status'
        });
    }
};

exports.getActiveTrucks = async (req, res) => {
    try {
        const rows = await trackingService.getActiveTrucks();

        return res.status(200).json({
            success: true,
            count: rows.length,
            data: rows
        });
    } catch (error) {
        console.error('getActiveTrucks error:', error);
        return res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch active trucks'
        });
    }
};

exports.getRouteHistoryBySession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const result = await trackingService.getRouteHistoryBySession(sessionId);

        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('getRouteHistoryBySession error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Failed to fetch route history'
        });
    }
};

exports.getTruckLatestSession = async (req, res) => {
    try {
        const { truckId } = req.params;
        const result = await trackingService.getTruckLatestSession(truckId);

        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('getTruckLatestSession error:', error);
        return res.status(400).json({
            success: false,
            message: error.message || 'Failed to fetch truck latest session'
        });
    }
};

exports.getTrackingReports = async (req, res) => {
    try {
        const rows = await trackingService.getTrackingReports();

        return res.status(200).json({
            success: true,
            count: rows.length,
            data: rows
        });
    } catch (error) {
        console.error("getTrackingReports error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to fetch tracking reports"
        });
    }
};

exports.getTrackingReportDetails = async (req, res) => {
    try {
        const { sessionId } = req.params;

        const result = await trackingService.getTrackingReportDetails(sessionId);

        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error("getTrackingReportDetails error:", error);
        return res.status(400).json({
            success: false,
            message: error.message || "Failed to fetch tracking report details"
        });
    }
};
