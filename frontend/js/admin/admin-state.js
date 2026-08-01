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
let activeTrackingTrucks = [];
let selectedTrackingTruck = null;
let selectedReliableRoutePoint = null;
let trackingMarkerStateBySession = {};

// Dispatch planning (kept separate from legacy tracking layers)
let dispatchLiveBySession = {};
let selectedDispatchTicket = null;
let dispatchPlannedLayerGroup = null;
let dispatchPlanningMap = null;
let dispatchPlanningLayerGroup = null;
let dispatchTicketRows = [];
let dispatchSetupRequired = false;
let dispatchDestinationCatalogSetupRequired = false;
let dispatchSelectedSessionActive = false;
let dispatchAddDestinationMode = false;
let dispatchPendingLinkTicketId = null;
let dispatchDestinationMode = "road_segment";
let dispatchDestinationSearchController = null;
let dispatchDestinationSearchTimer = null;
let dispatchDestinationResults = [];
let dispatchPopularDestinationResults = [];
let dispatchDestinationResultIndex = -1;
let dispatchDestinationPreview = null;
let dispatchPreviewMarker = null;
let dispatchPreviewGeometryLayer = null;
let dispatchStopMetadataSequence = 0;
const dispatchStopMetadata = new Map();
let dispatchLastAddedStopRow = null;
let dispatchRoutingRequestTimer = null;
let dispatchRoutingGeneration = 0;
let dispatchLastRoutingStart = null;
let dispatchLastRoutingSignature = "";
const dispatchRoutingCache = new Map();

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
