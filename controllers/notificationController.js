const db = require('../config/dbPromise');

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
  clearAllNotifications
};