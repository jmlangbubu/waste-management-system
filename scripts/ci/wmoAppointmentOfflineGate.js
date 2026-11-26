"use strict";

// No application imports or .env loading. Also used as Node's structured reporter
// and an offline preload in the isolated test processes, never as production code.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { StringDecoder } = require("node:string_decoder");
const ROOT = path.resolve(__dirname, "../..");
const CHILD_MARKER = "WMO_APPOINTMENT_OFFLINE_CI_CHILD";
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code) => { if (!value) fail(code); };
const spec = (file, tests, skips = []) => Object.freeze({ file, tests, skips: Object.freeze(skips) });

// Reviewed baseline: nine suites = 275 passed; HTTP = 6 passed/1 skipped;
// migration = 34 passed/12 skipped. The new gate's own 24 controls are mandatory.
const MANIFEST = Object.freeze([
  spec("tests/appointmentScheduling.test.js", 149),
  spec("tests/appointmentSecurity.test.js", 26),
  spec("tests/appointmentRequestFormUi.test.js", 21),
  spec("tests/appointmentUpdateEmail.test.js", 21),
  spec("tests/appointmentStatusPrefill.test.js", 6),
  spec("tests/orientationWorkflow.test.js", 33),
  spec("tests/orientationQueueUi.test.js", 14),
  spec("tests/orientationWebQuiz.test.js", 3),
  spec("tests/orientationCertificateGate.test.js", 2),
  spec("tests/appointmentMysql.integration.test.js", 7, ["real MySQL HTTP appointment integration (explicit local execution only)"]),
  spec("tests/appointmentMigrationDryRun.test.js", 46, ["A", "B", "C", "D", "E", "F_DDL", "F_WRITE", "F_UNCERTAIN", "F_ATTEST", "G", "H", "I"]
    .map(name => `REAL MYSQL migration ${name} (fresh independent database)`)),
  spec("tests/ci/wmoAppointmentOfflineGate.test.js", 24)
]);

function assertOfflineEnvironment(env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    const unsafe = /^(DATABASE_URL|MYSQL_URL|MYSQL_PWD|RESEND_API_KEY|APPOINTMENT_RESERVATIONS_ENABLED)$/.test(key)
      || /^(MYSQL_|WMO_APPOINTMENT_)/.test(key)
      || /^(NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT|NODE_V8_COVERAGE|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_USE_ENV_PROXY|NODE_USE_SYSTEM_CA|NODE_ICU_DATA|NODE_AUTH_TOKEN|SSL_CERT_FILE|SSL_CERT_DIR|OPENSSL_CONF|OPENSSL_MODULES|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV)$/.test(key)
      || key.startsWith("DYLD_");
    check(!unsafe, "UNSAFE_ENVIRONMENT:" + key); // Names only; never log values.
  }
}
function childEnvironment(env) {
  const child = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ", "CI", "GITHUB_ACTIONS"])
    if (env[key] !== undefined) child[key] = env[key];
  child[CHILD_MARKER] = "1";
  return child;
}
function assertRuntime(version = process.version, args = process.execArgv) {
  check(version === "v22.23.5" && args.length === 0, "UNAPPROVED_NODE_RUNTIME_OR_ARGUMENTS");
}
function installOfflineGuards() {
  const Module = require("node:module"), net = require("node:net");
  const original = Module._load;
  Module._load = function (name, ...args) {
    if (/^(mysql2|dotenv|resend|nodemailer)(?:\/|$)/.test(name) || /(?:^|[\\/])config[\\/]db(?:\.js)?$/.test(name)
      || /integration[\\/]appointments/.test(name)) fail("OFFLINE_IMPORT_FORBIDDEN");
    return original.call(this, name, ...args);
  };
  // Pipes used by Node's runner are permitted; TCP connections and listeners are not.
  const denied = () => fail("OFFLINE_NETWORK_FORBIDDEN");
  net.connect = net.createConnection = net.Socket.prototype.connect = net.Server.prototype.listen = denied;
}
if (process.env[CHILD_MARKER] === "1") installOfflineGuards();

async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type === "test:summary") yield JSON.stringify({ type, file: data.file || null, success: data.success, counts: data.counts }) + "\n";
    else if (type === "test:pass" || type === "test:fail") yield JSON.stringify({ type, file: data.file, name: data.name,
      nesting: data.nesting, skip: data.skip ?? false, todo: data.todo ?? false, kind: data.details?.type,
      failure: data.details?.error?.failureType || null }) + "\n";
  }
  // Test stdout/stderr is never interpreted as runner protocol or evidence of PASS.
  yield JSON.stringify({ type: "reporter:complete" }) + "\n";
}
function validate(records, outcome, manifest, root) {
  check(outcome.closed === true && outcome.code === 0 && outcome.signal === null && !outcome.fault, "CHILD_EXECUTION_FAILED");
  check(records.at(-1)?.type === "reporter:complete" && records.filter(r => r.type === "reporter:complete").length === 1, "INCOMPLETE_REPORT");
  check(records.every(r => ["test:pass", "test:fail", "test:summary", "reporter:complete"].includes(r.type)), "UNEXPECTED_RESULT");
  const expected = new Map(manifest.map(s => [path.resolve(root, s.file), s]));
  const summaries = records.filter(r => r.type === "test:summary"), total = summaries.filter(r => r.file === null);
  check(total.length === 1 && summaries.length === manifest.length + 1, "MISSING_OR_DUPLICATE_SUMMARY");
  const sums = { tests: 0, passed: 0, skipped: 0 };
  for (const [file, entry] of expected) {
    const summary = summaries.filter(r => r.file === file), results = records.filter(r => r.file === file && r.type !== "test:summary");
    check(summary.length === 1, "MISSING_REQUIRED_SUITE");
    const counts = summary[0].counts;
    check(summary[0].success === true && counts && counts.tests === entry.tests && counts.topLevel === entry.tests && counts.suites === 0
      && counts.passed === entry.tests - entry.skips.length && counts.skipped === entry.skips.length
      && counts.failed === 0 && counts.cancelled === 0 && counts.todo === 0, "SUITE_COUNT_OR_OUTCOME_MISMATCH:" + entry.file);
    check(results.length === entry.tests && results.every(r => r.type === "test:pass" && r.kind === "test" && r.nesting === 0 && r.todo === false
      && r.name !== file && !r.failure), "MISSING_OR_FAILED_TEST:" + entry.file);
    const skips = results.filter(r => r.skip !== false);
    check(skips.every(r => r.skip === true) && JSON.stringify(skips.map(r => r.name).sort()) === JSON.stringify([...entry.skips].sort()), "UNEXPECTED_SKIP:" + entry.file);
    sums.tests += counts.tests; sums.passed += counts.passed; sums.skipped += counts.skipped;
  }
  check(records.filter(r => r.file).every(r => expected.has(r.file)), "UNEXPECTED_SUITE");
  const aggregate = total[0];
  check(aggregate.success === true && aggregate.counts && Object.entries(sums).every(([k, v]) => aggregate.counts[k] === v)
    && aggregate.counts.topLevel === sums.tests && aggregate.counts.failed === 0 && aggregate.counts.cancelled === 0
    && aggregate.counts.todo === 0 && aggregate.counts.suites === 0, "INCOMPLETE_OR_FAILED_AGGREGATE");
  return sums;
}
function execute(args, { root, env, timeoutMs, graceMs, spawnImpl }) {
  return new Promise(resolve => {
    let child, closed = false, fault = null, text = "", bytes = 0, hard, abandoned, timer;
    const decoder = new StringDecoder("utf8");
    const settle = result => { clearTimeout(timer); clearTimeout(hard); clearTimeout(abandoned); resolve(result); };
    const stop = reason => {
      fault ||= reason;
      if (closed || hard) return;
      try { child?.kill("SIGTERM"); } catch (_) { /* Still fail; never infer closure. */ }
      hard = setTimeout(() => { try { child?.kill("SIGKILL"); } catch (_) { /* Wait for close. */ } }, graceMs);
      abandoned = setTimeout(() => { if (!closed) settle({ closed: false, fault: "CLOSE_UNCONFIRMED", text }); }, graceMs * 2);
    };
    try {
      child = spawnImpl(process.execPath, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.on("error", () => stop("SPAWN_OR_PROCESS_ERROR"));
      for (const stream of [child.stdout, child.stderr]) stream.on("error", () => stop("OUTPUT_PIPE_ERROR"));
      child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop("OUTPUT_LIMIT"); else text += decoder.write(chunk); });
      child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) stop("OUTPUT_LIMIT"); });
      child.once("close", (code, signal) => { closed = true; text += decoder.end(); settle({ code, signal, closed, fault, text }); });
      timer = setTimeout(() => stop("TIMEOUT"), timeoutMs);
    } catch (_) { settle({ closed: false, fault: "SPAWN_FAILED", text }); }
  });
}
async function runGate({ root = ROOT, manifest = MANIFEST, env = process.env, timeoutMs = 120000, graceMs = 1000, spawnImpl = spawn } = {}) {
  let outcome, records = [];
  try {
    assertOfflineEnvironment(env); // Before file loading and, crucially, before spawn.
    check(Array.isArray(manifest) && manifest.length > 0 && new Set(manifest.map(s => s.file)).size === manifest.length, "INVALID_MANIFEST");
    root = fs.realpathSync(root);
    const snapshots = manifest.map(entry => {
      check(Number.isSafeInteger(entry.tests) && entry.tests > entry.skips.length && Array.isArray(entry.skips)
        && new Set(entry.skips).size === entry.skips.length && typeof entry.file === "string" && entry.file.endsWith(".test.js"), "INVALID_MANIFEST");
      const file = path.resolve(root, entry.file), relative = path.relative(root, file);
      check(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.lstatSync(file).isFile()
        && fs.realpathSync(file) === file, "UNTRUSTED_TEST_FILE");
      return { file, digest: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    });
    const args = ["--unhandled-rejections=strict", "--require=" + __filename, "--test", "--test-concurrency=1", "--test-timeout=30000", "--test-reporter=" + pathToFileURL(__filename).href, ...snapshots.map(s => s.file)];
    outcome = await execute(args, { root, env: childEnvironment(env), timeoutMs, graceMs, spawnImpl });
    records = outcome.text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const counts = validate(records, outcome, manifest, root);
    check(snapshots.every(s => crypto.createHash("sha256").update(fs.readFileSync(s.file)).digest("hex") === s.digest), "TEST_SOURCE_CHANGED_DURING_RUN");
    return { ok: true, counts, files: manifest.length, records };
  } catch (error) { return { ok: false, reason: error.code || "INVALID_OR_INCOMPLETE_RESULT",
    process: outcome ? { closed: outcome.closed, code: outcome.code, signal: outcome.signal, fault: outcome.fault } : null,
    observedPassed: records.filter(r => r.type === "test:pass" && r.skip === false).length,
    completedFiles: records.filter(r => r.type === "test:summary" && r.file && r.success === true).map(r => r.file),
    failures: records.filter(r => r.type === "test:fail").map(({ file, name, failure }) => ({ file, name, failure })) }; }
}
Object.assign(reporter, { MANIFEST, assertOfflineEnvironment, childEnvironment, assertRuntime, validate, runGate });
module.exports = reporter;
if (require.main === module) {
  (async () => {
    assertRuntime();
    const result = await runGate();
    if (!result.ok) { console.error("WMO_APPOINTMENT_OFFLINE_CI_FAILED: " + JSON.stringify(result)); process.exitCode = 1; return; }
    for (const entry of MANIFEST) console.log(`${entry.file}: ${entry.tests - entry.skips.length} passed; ${entry.skips.length} intentional skips`);
    console.log(`WMO_APPOINTMENT_OFFLINE_CI_PASSED: ${result.counts.passed} passed; ${result.counts.skipped} explicitly allowed database skips; zero failures.`);
  })().catch(error => { console.error("WMO_APPOINTMENT_OFFLINE_CI_FAILED: " + (error.code || "UNCAUGHT_GATE_ERROR")); process.exitCode = 1; });
}
