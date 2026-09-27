const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

let certificateWrites = 0;
let orientationStatus = "failed_orientation";
const routes = [];
const db = {
  query(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    if (/^\s*CREATE TABLE/i.test(sql)) return callback(null, {});
    if (sql.includes("FROM appointments")) {
      return callback(null, [{ purpose: "SWM Orientation & Clearance", orientation_status: orientationStatus }]);
    }
    if (sql.includes("FROM certificates")) {
      return callback(null, sql.includes("WHERE id = ?")
        ? [{ id: 1, full_name: "Test Participant", orientation_token: "ORI-test" }]
        : []);
    }
    if (/^\s*INSERT INTO certificates/i.test(sql)) {
      certificateWrites += 1;
      return callback(null, { insertId: 1 });
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
};
const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  const parentPath = parent?.filename.replace(/\\/g, "/") || "";
  if (request === "express" && parentPath.endsWith("routes/certificateRoutes.js")) {
    return { Router: () => Object.fromEntries(["get", "post", "put", "delete"].map((method) => [
      method, (path, handler) => routes.push({ method, path, handler })
    ])) };
  }
  if (request === "../config/db" && parentPath.endsWith("routes/certificateRoutes.js")) return db;
  return originalLoad.call(this, request, parent, isMain);
};
try { require("../routes/certificateRoutes"); } finally { Module._load = originalLoad; }

function postCertificate() {
  return new Promise((resolve, reject) => {
    const route = routes.find((item) => item.method === "post" && item.path === "/");
    const req = { body: { full_name: "Test Participant", orientation_token: "ORI-test" } };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return body; }
    };
    try { route.handler(req, res); } catch (error) { reject(error); }
  });
}

test("failed, ready-for-retake, and incomplete orientation cannot issue a token-linked certificate", async () => {
  certificateWrites = 0;
  for (const state of ["failed_orientation", "ready_for_retake", "incomplete_orientation"]) {
    orientationStatus = state;
    const result = await postCertificate();
    assert.equal(result.statusCode, 403);
  }
  assert.equal(certificateWrites, 0);
});

test("passed completed orientation retains the existing certificate save path", async () => {
  certificateWrites = 0;
  orientationStatus = "completed_orientation";
  const result = await postCertificate();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.success, true);
  assert.equal(certificateWrites, 1);
});
