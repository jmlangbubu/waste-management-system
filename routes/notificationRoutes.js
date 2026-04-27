const express = require('express');
const router = express.Router();

const notificationController = require('../controllers/notificationController');

// GET ALL
router.get('/', notificationController.getNotifications);

// DELETE SINGLE
router.delete('/:id', notificationController.deleteNotification);

// CLEAR ALL
router.delete('/', notificationController.clearAllNotifications);

module.exports = router;