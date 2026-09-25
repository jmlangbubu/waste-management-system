const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_IMAGE_BYTES,
  validateImageFile,
  VehicleIssueUploadError
} = require("../middleware/vehicleIssueUpload");

const projectRoot = path.join(__dirname, "..");
const tests = [];
const test = (name, callback) => tests.push({ name, callback });
const read = (relativePath) => fs.readFileSync(
  path.join(projectRoot, relativePath),
  "utf8"
);

test("mobile routes are declared before generic Web id routes", () => {
  const source = read("routes/vehicleIssueRoutes.js");
  assert.ok(source.indexOf('"/mobile/assistant-schema"') >= 0);
  assert.ok(source.indexOf('"/mobile"') >= 0);
  assert.ok(source.indexOf('router.get("/:id"') >= 0);
  assert.ok(
    source.indexOf('"/mobile/assistant-schema"') < source.indexOf('router.get("/:id"')
  );
  assert.ok(source.indexOf('"/mobile"') < source.indexOf('router.get("/:id"'));
});

test("mobile routes use existing session auth and dedicated upload middleware", () => {
  const source = read("routes/vehicleIssueRoutes.js");
  assert.match(source, /requireMobileSession/);
  assert.match(source, /vehicleIssueImageUpload/);
  assert.match(source, /router\.post\([\s\S]*?"\/mobile"[\s\S]*?requireMobileSession[\s\S]*?vehicleIssueImageUpload/);
});

test("all Web routes use existing auth role and CSRF chain", () => {
  const source = read("routes/vehicleIssueRoutes.js");
  assert.match(source, /router\.use\(requireWebAuth\)/);
  assert.match(source, /requireWebRole\("super_admin", "personnel"\)/);
  assert.match(source, /router\.use\(requireCsrf\)/);
  assert.match(source, /router\.patch\("\/:id\/review"/);
  assert.match(source, /router\.post\("\/:id\/resolve"/);
});

test("server mounts only the new API route wiring", () => {
  const source = read("server/server.js");
  assert.match(source, /const vehicleIssueRoutes = require\("\.\.\/routes\/vehicleIssueRoutes"\)/);
  assert.match(source, /app\.use\("\/api\/vehicle-issues", vehicleIssueRoutes\)/);
});

test("migration has exact relationship types, category check, indexes, and no legacy trucks FK", () => {
  const source = read("database/migrations/20260925_vehicle_issue_reports.sql");
  assert.match(source, /id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT/);
  assert.match(source, /client_request_id VARCHAR\(160\)[\s\S]*?CHARACTER SET ascii[\s\S]*?COLLATE ascii_bin[\s\S]*?UNIQUE KEY uq_vehicle_issue_reports_client_request/);
  assert.match(source, /fleet_truck_id INT UNSIGNED NOT NULL/);
  assert.match(source, /reported_by_user_id INT NOT NULL/);
  assert.match(source, /dispatch_plan_id BIGINT UNSIGNED NOT NULL/);
  assert.match(source, /dispatch_ticket_id INT UNSIGNED NOT NULL/);
  assert.match(source, /tracking_session_id INT NOT NULL/);
  assert.match(source, /CHECK \([\s\S]*?'engine_overheating'[\s\S]*?'noise_vibration'[\s\S]*?'other'/);
  assert.match(source, /REFERENCES fleet_trucks \(id\)/);
  assert.doesNotMatch(source, /REFERENCES trucks \(id\)/);
  assert.match(source, /idx_vehicle_issue_reports_truck_status_created/);
  assert.match(source, /idx_vehicle_issue_reports_severity_status_created/);
});

test("rollback removes only the new table", () => {
  const source = read("database/migrations/20260925_vehicle_issue_reports_rollback.sql");
  assert.match(source, /DROP TABLE IF EXISTS vehicle_issue_reports/);
  assert.equal((source.match(/DROP TABLE/gi) || []).length, 1);
  assert.doesNotMatch(source, /ALTER TABLE|DELETE FROM|UPDATE /i);
});

test("image validator accepts JPEG PNG and WEBP", () => {
  for (const mimetype of ["image/jpeg", "image/png", "image/webp"]) {
    assert.ok(validateImageFile({ mimetype, size: 100, buffer: Buffer.alloc(1) }));
  }
});

test("image validator rejects unsupported MIME type", () => {
  assert.throws(
    () => validateImageFile({ mimetype: "image/gif", size: 100 }),
    (error) => error instanceof VehicleIssueUploadError &&
      error.code === "VEHICLE_ISSUE_IMAGE_TYPE_INVALID"
  );
});

test("image validator rejects files over five MB", () => {
  assert.throws(
    () => validateImageFile({
      mimetype: "image/jpeg",
      size: MAX_IMAGE_BYTES + 1
    }),
    (error) => error.code === "VEHICLE_ISSUE_IMAGE_TOO_LARGE" &&
      error.statusCode === 413
  );
});

test("production local fallback is explicitly disabled", () => {
  const source = read("middleware/vehicleIssueUpload.js");
  assert.match(source, /process\.env\.NODE_ENV !== "production"/);
  assert.match(source, /VEHICLE_ISSUE_ALLOW_LOCAL_UPLOADS === "true"/);
  assert.match(source, /VEHICLE_ISSUE_DURABLE_STORAGE_REQUIRED/);
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
  console.log(`${passed}/${tests.length} vehicle issue route tests passed`);
})();
