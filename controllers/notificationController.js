const db = require("../config/dbPromise");

/* =========================
   HELPERS
========================= */

function cleanText(value) {
  if (value === null || value === undefined) return "";

  const text = String(value).trim();

  if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
    return "";
  }

  return text;
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function getLimitedNumber(value, fallback = 50, max = 100) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

async function ensureCitizenNotificationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS citizen_notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      email VARCHAR(255) NULL,
      barangay VARCHAR(255) NULL,
      type VARCHAR(80) NOT NULL DEFAULT 'general',
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      reference_id VARCHAR(120) NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_citizen_notifications_user_id (user_id),
      INDEX idx_citizen_notifications_email (email),
      INDEX idx_citizen_notifications_barangay (barangay),
      INDEX idx_citizen_notifications_is_read (is_read),
      INDEX idx_citizen_notifications_created_at (created_at)
    )
  `);
}

function buildCitizenTargetWhere(query) {
  const userId = toPositiveInt(query.user_id || query.userId || query.citizen_id || query.citizenId);
  const email = cleanText(query.email);
  const barangay = cleanText(query.barangay);

  const conditions = [];
  const params = [];

  if (userId) {
    conditions.push("user_id = ?");
    params.push(userId);
  }

  if (email) {
    conditions.push("LOWER(email) = LOWER(?)");
    params.push(email);
  }

  if (barangay) {
    /*
      Barangay-wide notifications:
      Useful for waste data updates that should appear for all citizens
      assigned to the same barangay.
    */
    conditions.push("LOWER(barangay) = LOWER(?)");
    params.push(barangay);
  }

  return {
    whereSql: conditions.length > 0 ? `WHERE (${conditions.join(" OR ")})` : "",
    params,
    userId,
    email,
    barangay
  };
}

function mapCitizenNotificationRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    email: row.email || "",
    barangay: row.barangay || "",
    type: row.type || "general",
    title: row.title || "",
    message: row.message || "",
    reference_id: row.reference_id || "",
    is_read: Number(row.is_read) === 1,
    created_at: row.created_at,
    createdAt: row.created_at
  };
}

/*
  Reusable helper for other backend files later.
  Example:
  await createCitizenNotificationRecord({
    user_id: 5,
    email: "citizen@gmail.com",
    barangay: "Bula",
    type: "appointment",
    title: "Appointment Rescheduled",
    message: "Your appointment was moved to May 22, 2026.",
    reference_id: "APT-000028"
  });
*/
async function createCitizenNotificationRecord(data = {}) {
  await ensureCitizenNotificationsTable();

  const userId = toPositiveInt(data.user_id || data.userId || data.citizen_id || data.citizenId);
  const email = cleanText(data.email);
  const barangay = cleanText(data.barangay);
  const type = cleanText(data.type) || "general";
  const title = cleanText(data.title);
  const message = cleanText(data.message);
  const referenceId = cleanText(data.reference_id || data.referenceId);

  if (!title || !message) {
    throw new Error("Citizen notification title and message are required.");
  }

  const [result] = await db.query(
    `
      INSERT INTO citizen_notifications
        (user_id, email, barangay, type, title, message, reference_id, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `,
    [
      userId,
      email || null,
      barangay || null,
      type,
      title,
      message,
      referenceId || null
    ]
  );

  return result.insertId;
}

/* =========================
   CITIZEN NOTIFICATIONS
========================= */

const getCitizenNotifications = async (req, res) => {
  try {
    await ensureCitizenNotificationsTable();

    const { whereSql, params } = buildCitizenTargetWhere(req.query);
    const limit = getLimitedNumber(req.query.limit, 50, 100);

    /*
      If Android has no session identifiers, return empty safely instead of
      exposing all citizen notifications.
    */
    if (!whereSql) {
      return res.json({
        success: true,
        notifications: [],
        unread_count: 0
      });
    }

    const [rows] = await db.query(
      `
        SELECT DISTINCT
          id,
          user_id,
          email,
          barangay,
          type,
          title,
          message,
          reference_id,
          is_read,
          created_at
        FROM citizen_notifications
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT ?
      `,
      [...params, limit]
    );

    const [unreadRows] = await db.query(
      `
        SELECT COUNT(DISTINCT id) AS unread_count
        FROM citizen_notifications
        ${whereSql}
          AND is_read = 0
      `,
      params
    );

    res.json({
      success: true,
      notifications: rows.map(mapCitizenNotificationRow),
      unread_count: unreadRows[0]?.unread_count || 0
    });

  } catch (error) {
    console.error("getCitizenNotifications error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch citizen notifications"
    });
  }
};

const createCitizenNotification = async (req, res) => {
  try {
    const id = await createCitizenNotificationRecord(req.body || {});

    res.status(201).json({
      success: true,
      message: "Citizen notification created",
      id
    });

  } catch (error) {
    console.error("createCitizenNotification error:", error);

    res.status(400).json({
      success: false,
      message: error.message || "Failed to create citizen notification"
    });
  }
};

const markCitizenNotificationRead = async (req, res) => {
  try {
    await ensureCitizenNotificationsTable();

    const id = toPositiveInt(req.params.id);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Valid notification ID is required"
      });
    }

    await db.query(
      "UPDATE citizen_notifications SET is_read = 1 WHERE id = ?",
      [id]
    );

    res.json({
      success: true,
      message: "Citizen notification marked as read"
    });

  } catch (error) {
    console.error("markCitizenNotificationRead error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to mark notification as read"
    });
  }
};

const markAllCitizenNotificationsRead = async (req, res) => {
  try {
    await ensureCitizenNotificationsTable();

    const source = Object.keys(req.body || {}).length > 0 ? req.body : req.query;
    const { whereSql, params } = buildCitizenTargetWhere(source);

    if (!whereSql) {
      return res.status(400).json({
        success: false,
        message: "At least one identifier is required: user_id, email, or barangay"
      });
    }

    await db.query(
      `
        UPDATE citizen_notifications
        SET is_read = 1
        ${whereSql}
      `,
      params
    );

    res.json({
      success: true,
      message: "All matching citizen notifications marked as read"
    });

  } catch (error) {
    console.error("markAllCitizenNotificationsRead error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to mark notifications as read"
    });
  }
};

/* =========================
   EXISTING WMO/WEB NOTIFICATIONS
   Existing behavior preserved.
========================= */

// GET ALL
const getNotifications = async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM notifications ORDER BY createdAt DESC"
    );

    res.json({
      success: true,
      notifications: rows
    });

  } catch (error) {
    console.error("getNotifications error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch notifications"
    });
  }
};

// DELETE SINGLE
const deleteNotification = async (req, res) => {
  try {
    const id = req.params.id;

    await db.query("DELETE FROM notifications WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Notification deleted"
    });

  } catch (error) {
    console.error("deleteNotification error:", error);

    res.status(500).json({
      success: false,
      message: "Delete failed"
    });
  }
};

// CLEAR ALL
const clearAllNotifications = async (req, res) => {
  try {
    await db.query("DELETE FROM notifications");

    res.json({
      success: true,
      message: "All notifications cleared"
    });

  } catch (error) {
    console.error("clearAllNotifications error:", error);

    res.status(500).json({
      success: false,
      message: "Clear failed"
    });
  }
};

module.exports = {
  getNotifications,
  deleteNotification,
  clearAllNotifications,

  getCitizenNotifications,
  createCitizenNotification,
  markCitizenNotificationRead,
  markAllCitizenNotificationsRead,

  createCitizenNotificationRecord
};
