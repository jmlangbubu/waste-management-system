// =========================
// GLOBAL STATE
// =========================

// Waste + Users + Appointments
let validatedWasteRecords = [];
let allWebUsers = [];
let allAppointments = [];
let activePersonnel = [];
let currentUser = null;
let selectedRescheduleAppointmentId = null;

// Dashboard Filters
let dashboardRange = "day";
let categoryRange = "day";

// Notifications
let notificationsOpen = false;
let notificationsSeen = false;
let notificationFeedItems = [];
let lastNotificationSignature = "";
let notificationPollingInterval = null;
let notificationAudioUnlocked = false;
let notificationAudioContext = null;

// Tracking (Truck Map)
let truckMap = null;
let truckMarkers = {};
let selectedSessionId = null;
let selectedTruckId = null;
let selectedRoutePolyline = null;
let selectedStartMarker = null;
let selectedCurrentMarker = null;
let trackingPollInterval = null;
let isTruckMapInitialized = false;

// Charts
let wasteTrendChartInstance = null;
let submissionSourcesChartInstance = null;
let webUsersActivityChartInstance = null;
let wasteCategoryChartInstance = null;

// Complaints
let allComplaints = [];
let currentComplaint = null;
let complaintMapInstance = null;
let complaintMapMarker = null;
let complaintNearbyMarkers = [];
let complaintSelectedLine = null;
let complaintRoutingControl = null;
let selectedBarangayCandidate = null;

// Complaint Resolution
let resolvedComplaints = [];
let currentResolvedComplaint = null;
let complaintHistoryRecords = [];
let currentComplaintResolution = null;

// Orientation
let orientationAppointments = [];
let currentOrientationQrData = null;