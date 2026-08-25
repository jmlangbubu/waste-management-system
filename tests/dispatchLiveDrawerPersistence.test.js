const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  dispatchTicketIsTerminal,
  resolveDispatchMonitoringRefresh
} = require("../frontend/js/admin/admin-dispatch.js");

const ROOT = path.resolve(__dirname, "..");
const dispatchSource = fs.readFileSync(
  path.join(ROOT, "frontend/js/admin/admin-dispatch.js"),
  "utf8"
);
const trackingSource = fs.readFileSync(
  path.join(ROOT, "frontend/js/admin/admin-tracking.js"),
  "utf8"
);
const stateSource = fs.readFileSync(
  path.join(ROOT, "frontend/js/admin/admin-state.js"),
  "utf8"
);

function functionBlock(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

const liveSnapshot = Object.freeze({
  active: true,
  navigationGeneration: 7,
  sessionId: "58",
  ticketId: 420
});

function liveDetails(overrides = {}) {
  return {
    ticket: {
      id: 420,
      status: "in_progress",
      ticket_number: "DT-2026-0420",
      route_name: "North Route",
      ...overrides.ticket
    },
    stops: overrides.stops || [
      { id: 1, stop_order: 1, stop_status: "on_the_way", location_name: "Stop 1" },
      { id: 2, stop_order: 2, stop_status: "pending", location_name: "Stop 2" }
    ],
    tracking_sessions: overrides.tracking_sessions || []
  };
}

function testOpenLiveDispatchUsesExplicitLiveMode() {
  const openExisting = functionBlock(
    dispatchSource,
    "async function openDispatchExistingTicketForTruck",
    "async function resolveDispatchTicketBeforePlanning"
  );
  const renderer = functionBlock(
    dispatchSource,
    "function renderDispatchTicketDetails(details, options = {})",
    "const DISPATCH_PORTAL_MODAL_IDS"
  );
  assert.match(stateSource, /let dispatchPlannerMode = "create"/);
  assert.match(openExisting, /renderDispatchTicketDetails\(hydratedDetails\)/);
  assert.match(renderer, /setDispatchPlannerMode\("live"\)/);
}

function testSameTicketPollKeepsLiveModeAndIdentity() {
  assert.equal(resolveDispatchMonitoringRefresh(liveSnapshot, liveDetails()), "refresh");
  const refresh = functionBlock(
    dispatchSource,
    "function refreshDispatchMonitoringDetails",
    "async function loadDispatchForTrackingSession"
  );
  assert.match(refresh, /selectedDispatchTicket = details/);
  assert.doesNotMatch(refresh, /selectedSessionId\s*=/);
  assert.doesNotMatch(refresh, /setDispatchPlannerMode\("create"\)|closeDispatchPlannerDrawer/);
}

function testSameTicketPollKeepsDrawerVisible() {
  const load = functionBlock(
    dispatchSource,
    "async function loadDispatchForTrackingSession",
    "function dispatchMarkerIcon"
  );
  assert.match(load, /refreshAction === "refresh"[\s\S]*refreshDispatchMonitoringDetails/);
  assert.doesNotMatch(
    functionBlock(
      dispatchSource,
      "function refreshDispatchMonitoringDetails",
      "async function loadDispatchForTrackingSession"
    ),
    /closeDispatchPlannerDrawer/
  );
}

function testOlderTruckListResponseCannotNavigate() {
  const snapshotCheck = functionBlock(
    dispatchSource,
    "function dispatchSelectedTicketSnapshotIsCurrent",
    "function dispatchMonitoringSnapshotIsCurrent"
  );
  const open = functionBlock(
    dispatchSource,
    "async function openDispatchTicket",
    "function dispatchReportEndedAt"
  );
  assert.match(stateSource, /let dispatchWorkspaceNavigationGeneration = 0/);
  assert.match(snapshotCheck, /snapshot\.navigationGeneration === dispatchWorkspaceNavigationGeneration/);
  assert.match(open, /navigationGeneration !== dispatchWorkspaceNavigationGeneration/);
}

function testLiveDataChangesRefreshWithoutNavigation() {
  const gpsUpdate = liveDetails({
    tracking_sessions: [{ tracking_session_id: 58, last_updated_at: "2026-08-26T10:00:00+08:00" }]
  });
  const stopUpdate = liveDetails({
    stops: [
      { id: 1, stop_order: 1, stop_status: "completed", location_name: "Stop 1" },
      { id: 2, stop_order: 2, stop_status: "on_the_way", location_name: "Stop 2" }
    ]
  });
  const routeUpdate = liveDetails({ ticket: { route_name: "Updated North Route" } });
  assert.equal(resolveDispatchMonitoringRefresh(liveSnapshot, gpsUpdate), "refresh");
  assert.equal(resolveDispatchMonitoringRefresh(liveSnapshot, stopUpdate), "refresh");
  assert.equal(resolveDispatchMonitoringRefresh(liveSnapshot, routeUpdate), "refresh");
}

function testActiveRouteRemainsVisibleDuringPolling() {
  const refresh = functionBlock(
    dispatchSource,
    "function refreshDispatchMonitoringDetails",
    "async function loadDispatchForTrackingSession"
  );
  assert.match(refresh, /renderDispatchPlannedRoute\(details/);
  assert.match(refresh, /preservePlannerMode: true/);
  assert.doesNotMatch(refresh, /clearDispatchPlannedRoute|clearDispatchDestinationMarkers/);
}

function testExplicitBackAndCloseExitMonitoring() {
  const setup = functionBlock(
    dispatchSource,
    "function setupDispatchModule",
    "if (typeof module"
  );
  const close = functionBlock(
    dispatchSource,
    "function closeDispatchPlannerDrawer",
    "function setDispatchWorkspaceTab"
  );
  assert.match(setup, /dispatchPlannerBackBtn[\s\S]*closeDispatchPlannerDrawer/);
  assert.match(setup, /dispatchPlannerCloseBtn[\s\S]*closeDispatchPlannerDrawer/);
  assert.match(close, /markDispatchWorkspaceNavigation\(\)/);
  assert.match(close, /dispatchPlannerMode === "live"[\s\S]*setDispatchPlannerMode\("create"\)/);
}

function testTerminalTicketIsOnlyPollingExit() {
  assert.equal(dispatchTicketIsTerminal({ status: "completed" }), true);
  assert.equal(dispatchTicketIsTerminal({ status: "cancelled" }), true);
  assert.equal(dispatchTicketIsTerminal({ status: "in_progress" }), false);
  assert.equal(
    resolveDispatchMonitoringRefresh(liveSnapshot, liveDetails({ ticket: { status: "completed" } })),
    "exit_terminal"
  );
  assert.equal(
    resolveDispatchMonitoringRefresh(liveSnapshot, liveDetails({ ticket: { status: "cancelled" } })),
    "exit_terminal"
  );
  assert.equal(resolveDispatchMonitoringRefresh(liveSnapshot, null), "preserve");
  assert.equal(
    resolveDispatchMonitoringRefresh(liveSnapshot, liveDetails({ ticket: { id: 999 } })),
    "preserve"
  );
}

function testActiveDispatchPriorityCannotBecomeAvailable() {
  const eligibility = functionBlock(
    dispatchSource,
    "function setDispatchNewTicketEligibility",
    "async function resolveDispatchNewTicketEligibility"
  );
  const state = functionBlock(
    trackingSource,
    "function getTrackingTruckDispatchState",
    "function resolveTrackingMonitoredDispatch"
  );
  const poll = functionBlock(
    trackingSource,
    "async function loadActiveTrucks",
    "function getTrackingInlineIcon"
  );
  const retainedCard = functionBlock(
    dispatchSource,
    "function getDispatchTrackingCardForSession",
    "function getDispatchLiveForTicket"
  );
  assert.match(eligibility, /dispatchTicketIsLive\(confirmedTicket\)/);
  assert.match(eligibility, /status: "existing_dispatch"/);
  assert.ok(state.indexOf("Active Dispatch") < state.indexOf("Available for dispatch"));
  assert.match(poll, /getDispatchTrackingCardForSession\(sessionId\)/);
  assert.match(retainedCard, /monitoringSnapshot\.hasLiveTicket[\s\S]*dispatchTicketFromDetails\(selectedDispatchTicket\)/);
}

function testSameTicketRefreshPreservesScrollPosition() {
  const renderer = functionBlock(
    dispatchSource,
    "function renderDispatchTicketDetails(details, options = {})",
    "const DISPATCH_PORTAL_MODAL_IDS"
  );
  const refresh = functionBlock(
    dispatchSource,
    "function refreshDispatchMonitoringDetails",
    "async function loadDispatchForTrackingSession"
  );
  assert.match(refresh, /preserveScroll: true/);
  assert.match(renderer, /const previousScrollTop = options\.preserveScroll/);
  assert.match(renderer, /scrollContainer\.scrollTop = previousScrollTop/);
}

function testPollingHydrationIsRefreshOnly() {
  const hydration = functionBlock(
    trackingSource,
    "async function hydrateSelectedTruckWorkspace",
    "function resetTrackingView"
  );
  const poll = functionBlock(
    trackingSource,
    "async function loadActiveTrucks",
    "function getTrackingInlineIcon"
  );
  assert.match(poll, /hydrateSelectedTruckWorkspace\(selectedSessionId, \{ keepView: true \}\)/);
  assert.match(hydration, /refreshOnly: options\.keepView === true/);
}

function run() {
  testOpenLiveDispatchUsesExplicitLiveMode();
  testSameTicketPollKeepsLiveModeAndIdentity();
  testSameTicketPollKeepsDrawerVisible();
  testOlderTruckListResponseCannotNavigate();
  testLiveDataChangesRefreshWithoutNavigation();
  testActiveRouteRemainsVisibleDuringPolling();
  testExplicitBackAndCloseExitMonitoring();
  testTerminalTicketIsOnlyPollingExit();
  testActiveDispatchPriorityCannotBecomeAvailable();
  testSameTicketRefreshPreservesScrollPosition();
  testPollingHydrationIsRefreshOnly();
  console.log("dispatchLiveDrawerPersistence.test.js: all assertions passed");
}

run();
