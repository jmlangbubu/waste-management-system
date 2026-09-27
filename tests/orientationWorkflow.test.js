const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const originalLoad = Module._load;
const routes = [];
const record = {
  id: 17,
  purpose: "SWM Orientation & Clearance",
  status: "approved",
  orientation_status: "pending_orientation",
  orientation_score: null,
  orientation_started_at: null,
  orientation_completed_at: null,
  orientation_completed: 0,
  orientation_token: "ORI-test"
};
let role = "personnel";
let updates = 0;

function reset(state = "pending_orientation") {
  Object.assign(record, {
    status: "approved", orientation_status: state, orientation_score: null,
    orientation_started_at: null, orientation_completed_at: null,
    orientation_completed: 0
  });
  role = "personnel";
  updates = 0;
}

const db = {
  query(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    if (/^\s*SELECT/i.test(sql)) {
      return callback(null, sql.includes("orientation_token = ?")
        ? (params[0] === record.orientation_token ? [{ ...record }] : [])
        : (Number(params[0]) === record.id ? [{ ...record }] : []));
    }
    if (!/^\s*UPDATE appointments/i.test(sql)) throw new Error(`Unexpected query: ${sql}`);
    let eligible = false;
    if (sql.includes("orientation_token = ?")) {
      eligible = params[0] === record.orientation_token && record.status === "approved" &&
        ["approved", "pending_orientation", "ready_for_retake"].includes(record.orientation_status);
    } else {
      eligible = Number(params[sql.includes("orientation_score = ?") ? 1 : 0]) === record.id &&
        record.status === "approved";
      if (sql.includes("orientation_status = 'ready_for_retake'")) {
        eligible &&= record.orientation_status === "failed_orientation";
      } else {
        eligible &&= record.orientation_status === params.at(-1);
      }
    }
    if (!eligible) return callback(null, { affectedRows: 0 });
    updates += 1;
    if (sql.includes("orientation_status = 'ready_for_retake'")) {
      record.orientation_status = "ready_for_retake";
    } else if (sql.includes("orientation_status = 'incomplete_orientation'")) {
      record.orientation_status = "incomplete_orientation";
      record.orientation_completed_at = "2026-09-26 10:00:00";
    } else if (sql.includes("orientation_status = 'completed_orientation'")) {
      record.status = "completed";
      record.orientation_status = "completed_orientation";
      record.orientation_score = params[0];
      record.orientation_completed = 1;
      record.orientation_completed_at = "2026-09-26 10:00:00";
    } else if (sql.includes("orientation_status = 'failed_orientation'")) {
      record.orientation_status = "failed_orientation";
      record.orientation_score = params[0];
      record.orientation_completed = 0;
      record.orientation_completed_at = null;
    } else if (sql.includes("orientation_status = 'pending_orientation'")) {
      record.orientation_status = "pending_orientation";
      record.orientation_started_at ||= "2026-09-26 09:00:00";
    }
    return callback(null, { affectedRows: 1 });
  }
};

Module._load = function mockedLoad(request, parent, isMain) {
  const parentPath = parent?.filename.replace(/\\/g, "/") || "";
  if (request === "express" && parentPath.endsWith("routes/appointmentRoutes.js")) {
    return { Router: () => Object.fromEntries(["get", "post", "put", "delete"].map((method) => [
      method, (path, ...handlers) => routes.push({ method, path, handlers: handlers.flat() })
    ])) };
  }
  if (request === "../config/db" && parentPath.endsWith("routes/appointmentRoutes.js")) return db;
  if (request === "resend" && parentPath.endsWith("routes/appointmentRoutes.js")) {
    return { Resend: class Resend {} };
  }
  if (request === "qrcode" && parentPath.endsWith("routes/appointmentRoutes.js")) return {};
  if (request === "../services/webSessionService" && parentPath.endsWith("middleware/webSessionAuth.js")) {
    return {
      validateSession: async (token) => {
        if (token !== "valid") throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
        return { id: 1, user: { id: 2, role }, csrfTokenHash: "hash:csrf" };
      },
      hashOpaqueToken: (value) => `hash:${value}`,
      normalizeWebRole: (value) => String(value || "").toLowerCase()
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
try { require("../routes/appointmentRoutes"); } finally { Module._load = originalLoad; }

async function invoke(method, path, options = {}) {
  const route = routes.find((entry) => entry.method === method && entry.path === path);
  assert.ok(route, `Route ${method} ${path} exists`);
  const req = {
    method: method.toUpperCase(),
    params: { id: String(record.id), token: record.orientation_token },
    body: options.body || {},
    headers: {
      cookie: `${options.auth === false ? "" : "wmo_admin_session=valid; "}wmo_admin_csrf=csrf`,
      "x-csrf-token": options.csrf === false ? "bad" : "csrf"
    }
  };
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  for (const handler of route.handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

test("failed score is stored without completion or certificate eligibility", async () => {
  reset();
  const res = await invoke("put", "/orientation/complete/:token", { body: { score: 7 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.passed, false);
  assert.equal(res.body.certificate_eligible, false);
  assert.equal(record.orientation_status, "failed_orientation");
  assert.equal(record.orientation_score, 7);
  assert.equal(record.status, "approved");
  assert.equal(record.orientation_completed_at, null);
});

test("failed orientation cannot submit again until WMO allows a retake", async () => {
  reset("failed_orientation");
  assert.equal((await invoke("put", "/orientation/complete/:token", { body: { score: 10 } })).statusCode, 409);
  assert.equal((await invoke("put", "/orientation/start/:token")).statusCode, 409);
  assert.equal(record.orientation_status, "failed_orientation");
});

test("repeating the same failed submission is safe and does not overwrite the attempt", async () => {
  reset("failed_orientation");
  record.orientation_score = 3;
  const result = await invoke("put", "/orientation/complete/:token", { body: { score: 3 } });
  assert.equal(result.body.passed, false);
  assert.equal(result.body.changed, false);
  assert.equal(updates, 0);
});

test("Allow Retake preserves failed score, permits one new attempt, and is idempotent", async () => {
  reset("failed_orientation");
  record.orientation_score = 3;
  const first = await invoke("post", "/orientation/:id/allow-retake");
  const second = await invoke("post", "/orientation/:id/allow-retake");
  assert.equal(first.body.orientation_status, "ready_for_retake");
  assert.equal(second.body.changed, false);
  assert.equal(record.orientation_score, 3);
  assert.equal(updates, 1);
  assert.equal((await invoke("put", "/orientation/start/:token")).statusCode, 200);
  assert.equal(record.orientation_status, "pending_orientation");
});

test("Completed and Incomplete orientations cannot be reopened", async () => {
  for (const state of ["completed_orientation", "incomplete_orientation"]) {
    reset(state);
    assert.equal((await invoke("post", "/orientation/:id/allow-retake")).statusCode, 409);
    assert.equal(updates, 0);
  }
});

test("Mark as Incomplete is terminal, idempotent, and preserves last score", async () => {
  reset("failed_orientation");
  record.orientation_score = 2;
  const first = await invoke("post", "/orientation/:id/mark-incomplete");
  const second = await invoke("post", "/orientation/:id/mark-incomplete");
  assert.equal(first.body.orientation_status, "incomplete_orientation");
  assert.equal(second.body.changed, false);
  assert.equal(record.orientation_score, 2);
  assert.equal(record.orientation_completed, 0);
  assert.ok(record.orientation_completed_at);
  assert.equal(updates, 1);
});

test("Completed orientation cannot be marked incomplete", async () => {
  reset("completed_orientation");
  assert.equal((await invoke("post", "/orientation/:id/mark-incomplete")).statusCode, 409);
  assert.equal(updates, 0);
});

test("passing Android score completes once, with preserved score and timestamp", async () => {
  reset();
  const first = await invoke("put", "/orientation/complete/:token", { body: { score: 8 } });
  const second = await invoke("put", "/orientation/complete/:token", { body: { score: 8 } });
  assert.equal(first.body.passed, true);
  assert.equal(first.body.certificate_eligible, true);
  assert.equal(second.body.changed, false);
  assert.equal(record.orientation_status, "completed_orientation");
  assert.equal(record.orientation_score, 8);
  assert.ok(record.orientation_completed_at);
  assert.equal(updates, 1);
});

test("web quiz uses its existing 4-of-5 threshold; invalid scores are rejected", async () => {
  const answers = require("../utils/orientationWorkflow").WEB_ORIENTATION_ANSWERS;
  reset();
  assert.equal((await invoke("put", "/orientation/complete/:token", {
    body: { score: 3, total_questions: 5, answers: [...answers.slice(0, 3), null, null] }
  })).body.passed, false);
  reset();
  assert.equal((await invoke("put", "/orientation/complete/:token", {
    body: { score: 4, total_questions: 5, answers: [...answers.slice(0, 4), null] }
  })).body.passed, true);
  reset();
  assert.equal((await invoke("put", "/orientation/complete/:token", {
    body: { score: 4, total_questions: 5, answers: [null, null, null, null, null] }
  })).statusCode, 400);
  assert.equal((await invoke("put", "/orientation/complete/:token", { body: { score: null } })).statusCode, 400);
});

test("WMO mutations require authentication, correct role, and CSRF", async () => {
  reset("failed_orientation");
  for (const action of ["/orientation/:id/allow-retake", "/orientation/:id/mark-incomplete"]) {
    assert.equal((await invoke("post", action, { auth: false })).statusCode, 401);
    role = "citizen";
    assert.equal((await invoke("post", action)).statusCode, 403);
    role = "personnel";
    assert.equal((await invoke("post", action, { csrf: false })).statusCode, 403);
  }
  assert.equal(updates, 0);
});

test("appointment History distinguishes incomplete and excludes still-active failed retakes", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/appointmentRoutes.js"), "utf8");
  const historyQuery = source.split('router.get("/history"')[1].split('router.get("/orientation"')[0];
  assert.match(historyQuery, /THEN 'incomplete'/);
  assert.match(historyQuery, /'failed_orientation', 'ready_for_retake'/);
  assert.match(historyQuery, /'completed_orientation'/);
});

test("server Web answer key stays aligned with the existing five-question exam", () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/js/orientation-quiz.js"), "utf8");
  const context = { document: { addEventListener() {} } };
  vm.createContext(context);
  vm.runInContext(source, context);
  const webAnswers = Array.from(vm.runInContext("quizQuestions.map((question) => question.answer)", context));
  assert.deepEqual(webAnswers, require("../utils/orientationWorkflow").WEB_ORIENTATION_ANSWERS);
});
