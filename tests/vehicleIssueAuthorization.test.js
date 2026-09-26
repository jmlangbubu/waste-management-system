const assert = require("node:assert/strict");
const Module = require("node:module");

const originalModuleLoad = Module._load;
Module._load = function loadWithAuthorizationMocks(request, parent, isMain) {
  const parentPath = parent?.filename.replace(/\\/g, "/") || "";
  if (
    request === "../services/mobileSessionService" &&
    parentPath.endsWith("middleware/mobileSessionAuth.js")
  ) {
    return {
      authenticateMobileSession: async () => {
        throw new Error("not used");
      },
      isValidOpaqueToken: (value) => /^[A-Za-z0-9_-]{20,}$/.test(String(value || ""))
    };
  }
  if (
    request === "../services/webSessionService" &&
    parentPath.endsWith("middleware/webSessionAuth.js")
  ) {
    return {
      validateSession: async () => {
        throw new Error("not used");
      },
      hashOpaqueToken: (value) => `hash:${String(value || "")}`,
      normalizeWebRole: (value) => String(value || "").trim().toLowerCase()
    };
  }
  if (
    request === "../config/dbPromise" &&
    parentPath.endsWith("services/vehicleIssueService.js")
  ) {
    return {};
  }
  if (
    request === "../middleware/vehicleIssueUpload" &&
    parentPath.endsWith("services/vehicleIssueService.js")
  ) {
    return {
      VehicleIssueUploadError: class VehicleIssueUploadError extends Error {},
      storeVehicleIssueImage: async () => null,
      deleteStoredVehicleIssueImage: async () => undefined
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const {
  buildRequireMobileSession,
  readBearerToken
} = require("../middleware/mobileSessionAuth");
const {
  buildRequireWebAuth,
  requireWebRole,
  requireCsrf
} = require("../middleware/webSessionAuth");
const {
  requireEligibleEnforcer
} = require("../services/vehicleIssueService");
Module._load = originalModuleLoad;

const tests = [];
const test = (name, callback) => tests.push({ name, callback });

function response() {
  return {
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; }
  };
}

test("unauthenticated mobile request is rejected", async () => {
  const req = { headers: {} };
  const res = response();
  let nextCalled = false;
  await buildRequireMobileSession({ authenticateMobileSession: async () => null })(
    req,
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "MOBILE_SESSION_REQUIRED");
});

test("malformed bearer token is rejected before session lookup", () => {
  assert.equal(
    readBearerToken({ headers: { authorization: "Bearer short" } }).code,
    "MOBILE_SESSION_MALFORMED"
  );
});

test("valid bearer session populates only server-authenticated mobile identity", async () => {
  const service = {
    authenticateMobileSession: async () => ({
      id: 91,
      deviceId: "device-safe",
      expiresAt: "2026-09-26T00:00:00Z",
      user: { id: 13, role: "enforcer", status: "active" }
    })
  };
  const req = {
    headers: { authorization: `Bearer ${"A".repeat(24)}` },
    body: { reported_by_user_id: 999 }
  };
  const res = response();
  let nextCalled = false;
  await buildRequireMobileSession(service)(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.mobileUser.id, 13);
  assert.equal(req.body.reported_by_user_id, 999);
});

test("wrong mobile role is rejected by vehicle issue authorization", () => {
  assert.throws(
    () => requireEligibleEnforcer({ id: 13, role: "collector", status: "active" }),
    (error) => error.code === "VEHICLE_ISSUE_ENFORCER_REQUIRED" &&
      error.statusCode === 403
  );
});

test("inactive Enforcer is rejected by vehicle issue authorization", () => {
  assert.throws(
    () => requireEligibleEnforcer({ id: 13, role: "enforcer", status: "inactive" }),
    (error) => error.code === "VEHICLE_ISSUE_ENFORCER_REQUIRED" &&
      error.statusCode === 403
  );
});

test("unauthenticated Web role check is rejected", () => {
  const res = response();
  let nextCalled = false;
  requireWebRole("super_admin", "personnel")({}, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "WEB_SESSION_REQUIRED");
});

test("unauthenticated Web session is rejected by existing auth middleware", async () => {
  const res = response();
  let nextCalled = false;
  await buildRequireWebAuth({
    validateSession: async () => {
      const error = new Error("Web Admin authentication is required.");
      error.statusCode = 401;
      error.code = "WEB_SESSION_REQUIRED";
      throw error;
    }
  })(
    { headers: {} },
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "WEB_SESSION_REQUIRED");
});

test("unauthorized Web role is rejected", () => {
  const res = response();
  let nextCalled = false;
  requireWebRole("super_admin", "personnel")(
    { user: { role: "viewer" } },
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "WEB_ROLE_FORBIDDEN");
});

test("authorized Web roles pass role check", () => {
  for (const role of ["super_admin", "personnel"]) {
    const res = response();
    let nextCalled = false;
    requireWebRole("super_admin", "personnel")(
      { user: { role } },
      res,
      () => { nextCalled = true; }
    );
    assert.equal(nextCalled, true);
  }
});

test("missing CSRF is rejected for review and resolution mutations", () => {
  for (const method of ["PATCH", "POST"]) {
    const res = response();
    let nextCalled = false;
    requireCsrf(
      {
        method,
        headers: {},
        user: { id: 4, role: "personnel" },
        webSession: { csrfTokenHash: "hash:expected" }
      },
      res,
      () => { nextCalled = true; }
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "WEB_CSRF_INVALID");
  }
});

test("mismatched CSRF header and cookie are rejected", () => {
  const res = response();
  let nextCalled = false;
  requireCsrf(
    {
      method: "POST",
      headers: {
        cookie: "wmo_admin_csrf=expected",
        "x-csrf-token": "different"
      },
      user: { id: 4, role: "personnel" },
      webSession: { csrfTokenHash: "hash:expected" }
    },
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "WEB_CSRF_INVALID");
});

test("safe Web GET does not require a CSRF token after authentication", () => {
  const res = response();
  let nextCalled = false;
  requireCsrf(
    { method: "GET", headers: {}, user: { id: 4 }, webSession: {} },
    res,
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);
});

(async () => {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.callback();
      passed += 1;
      console.log(`PASS ${current.name}`);
    } catch (error) {
      console.error(`FAIL ${current.name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${tests.length} vehicle issue authorization tests passed`);
})();
