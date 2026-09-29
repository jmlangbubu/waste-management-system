const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { test } = require("node:test");
const { ROLE_CAPABILITIES, getWebCapabilities, hasWebCapability } = require("../config/webRoleCapabilities");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("exactly five documented roles resolve to a fail-closed capability matrix", () => {
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES).sort(), [
    "clerk_admin", "division_admin", "personnel", "super_admin", "supervisor"
  ]);
  for (const role of Object.keys(ROLE_CAPABILITIES)) {
    assert.equal(hasWebCapability(role, "dashboard.view"), true);
    assert.equal(hasWebCapability(role, "users.manage"), role === "super_admin");
    assert.equal(hasWebCapability(role, "waste.view"), role !== "personnel");
  }
  assert.equal(hasWebCapability("clerk_admin", "tracking.view"), false);
  assert.equal(hasWebCapability("division_admin", "dispatch.view"), false);
  assert.equal(hasWebCapability("supervisor", "appointments.view"), false);
  for (const capability of ["tracking.view", "fleet.view", "dispatch.view"]) {
    assert.equal(hasWebCapability("personnel", capability), true);
  }
  assert.deepEqual(getWebCapabilities("unknown"), []);
  assert.deepEqual(getWebCapabilities("admin"), []);
  assert.deepEqual(getWebCapabilities("head_admin"), []);
});

test("browser section access derives from authenticated session capabilities, not claimed role", () => {
  const context = { window: {}, SECTION_IDS: {
    dashboard: "dashboardSection", records: "recordsSection",
    appointments: "appointmentsSection", orientation: "orientationSection",
    complaints: "complaintsSection", tracking: "trackingSection",
    userManagement: "userManagementSection"
  } };
  vm.createContext(context);
  vm.runInContext(read("frontend/js/admin/admin-session.js"), context);
  for (const role of Object.keys(ROLE_CAPABILITIES)) {
    const user = context.normalizeCurrentUser({ role }, getWebCapabilities(role));
    assert.equal(context.canAccessSection(user, "userManagementSection"), role === "super_admin");
    assert.equal(context.canAccessSection(user, "recordsSection"), role !== "personnel");
    assert.equal(context.canAccessSection(user, "trackingSection"), ["super_admin", "personnel"].includes(role));
  }
  const spoofed = context.normalizeCurrentUser({ role: "super_admin", capabilities: ["users.manage"] });
  assert.equal(context.canAccessSection(spoofed, "userManagementSection"), false);
  assert.equal(context.canAccessSection(null, "dashboardSection"), false);
});

test("sidebar visibility differs by role without changing its structure", () => {
  function element(section = null) {
    const classes = new Set();
    return {
      hidden: false,
      getAttribute(name) { return name === "data-section" ? section : null; },
      setAttribute() {}, removeAttribute() {},
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); }
      },
      style: { setProperty() {}, removeProperty() {} }
    };
  }
  const nav = ["dashboardSection", "recordsSection", "appointmentsSection",
    "complaintsSection", "trackingSection", "userManagementSection"].map(element);
  const elements = {
    navUserManagement: nav[5],
    openCalendarActivitiesBtn: element(),
    openIncomingInvoiceBtn: element(),
    sidebarOtherGroup: element()
  };
  const context = { window: {}, SECTION_IDS: {
    dashboard: "dashboardSection", records: "recordsSection",
    appointments: "appointmentsSection", orientation: "orientationSection",
    complaints: "complaintsSection", tracking: "trackingSection",
    userManagement: "userManagementSection"
  }, document: {
    querySelectorAll() { return nav; },
    getElementById(id) { return elements[id] || null; }
  } };
  vm.createContext(context);
  vm.runInContext(read("frontend/js/admin/admin-session.js"), context);
  const expected = {
    super_admin: [false, false, false, false, false, false],
    clerk_admin: [false, false, false, false, true, true],
    division_admin: [false, false, true, false, true, true],
    supervisor: [false, false, true, false, true, true],
    personnel: [false, true, true, true, false, true]
  };
  for (const role of Object.keys(expected)) {
    context.setModuleNavigationVisibility({ role, capabilities: getWebCapabilities(role) });
    assert.deepEqual(nav.map((button) => button.hidden), expected[role], role);
    assert.equal(elements.sidebarOtherGroup.hidden, !["super_admin", "clerk_admin"].includes(role));
  }
});

test("every visible sidebar section has a real content target", () => {
  const html = read("frontend/admin-dashboard.html");
  const targets = [...html.matchAll(/class="nav-btn(?: active)?" data-section="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.equal(targets.length, 6);
  for (const target of targets) {
    assert.match(html, new RegExp(`<section id="${target}"`));
  }
  assert.match(html, /class="web-session-pending"/);
});

test("web routes use capability guards without changing shared mobile paths", () => {
  const waste = read("routes/wasteRoutes.js");
  const notifications = read("routes/notificationRoutes.js");
  assert.match(waste, /router\.get\("\/web\/validated-records", requireWebCapability\("waste\.view"\)/);
  assert.match(waste, /router\.get\("\/validated-records", wasteController\.getValidatedWasteRecords\)/);
  assert.match(waste, /router\.post\("\/validated-records", wasteController\.createValidatedWasteRecord\)/);
  assert.match(notifications, /router\.get\("\/citizen", notificationController\.getCitizenNotifications\)/);
  assert.match(notifications, /router\.get\("\/", requireWebCapability\("notifications\.view"\)/);
  assert.match(notifications, /router\.delete\("\/:id", requireWebCapability\("notifications\.manage"\), requireCsrf/);
  assert.match(read("routes/webAuthRoutes.js"), /capabilities: getWebCapabilities\(req\.user\.role\)/);
});

test("capability middleware requires a valid session and denies unknown or unauthorized roles", async () => {
  const filename = require.resolve("../middleware/webSessionAuth");
  const originalLoad = Module._load;
  let role = "super_admin";
  const sessionService = {
    validateSession: async (token) => {
      if (!token || token === "invalid") {
        throw Object.assign(new Error("Invalid session"), { statusCode: 401, code: "WEB_SESSION_INVALID" });
      }
      return { id: 1, user: { id: 7, role }, csrfTokenHash: "hash", expiresAt: "later" };
    },
    normalizeWebRole: (value) => String(value || "").trim().toLowerCase(),
    hashOpaqueToken: () => "unused"
  };
  delete require.cache[filename];
  Module._load = function mockSession(request, parent, isMain) {
    if (request === "../services/webSessionService" && parent?.filename === filename) {
      return sessionService;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let auth;
  try {
    auth = require(filename);
  } finally {
    Module._load = originalLoad;
  }

  async function check(cookie) {
    const req = {
      headers: { cookie },
      body: { role: "super_admin" },
      query: { role: "super_admin" }
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    for (const middleware of auth.requireWebCapability("users.manage")) {
      let nextCalled = false;
      await middleware(req, res, () => { nextCalled = true; });
      if (!nextCalled) return res;
    }
    return res;
  }

  const validCookie = `wmo_admin_session=${"S".repeat(43)}`;
  assert.equal((await check(validCookie)).statusCode, 200);
  role = "clerk_admin";
  assert.equal((await check(validCookie)).statusCode, 403);
  role = "unknown";
  assert.equal((await check(validCookie)).statusCode, 403);
  assert.equal((await check("")).statusCode, 401);
  assert.equal((await check("wmo_admin_session=invalid")).statusCode, 401);
});
