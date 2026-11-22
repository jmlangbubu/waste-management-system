"use strict";

// Importing this file is inert. A public trust pin does not authorize native execution.
const crypto = require("node:crypto");
const e = require("./environment.cjs");
const schema = require("./schema.cjs");
const OWNER_KEY_SPKI_SHA256 = "4349e07a097600d70940fa3ab4438339217e9442e7e5270773389dd828006700";
const OWNER_TRUST = Object.freeze({ owner: "wmo-appointment-owner-v1", publicKey:
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEArJujNNHCPoXEkOCu4i8/35G8b6wQ+wXsCrXemWX/SQ4=\n-----END PUBLIC KEY-----\n" });
// Changing this requires separate owner authorization, source review and a new reviewed commit. No input can enable it.
const NATIVE_ACTIVATION_ENABLED = false;
const challenges = new WeakMap(), sessions = new WeakMap(), scopes = new WeakMap();
const ACTIONS = Object.freeze(["provision", "verify", "attest", "connect-check", "teardown"]);
const WRITES = new Set(["provision", "attest", "teardown"]);
const FILES = Object.freeze(["README.md", "compose.yaml", "run.cjs", "harness.offline.test.cjs", "native.offline.test.cjs",
  ...["environment", "schema", "runtime", "assertions", "control", "disposable", "nativeHost", "nativeDocker", "nativeMysql", "nativeLifecycle"].map(n => "helpers/" + n + ".cjs")]);
const CODES = new Set(["TRUST_UNAVAILABLE", "AUTH_INVALID", "AUTH_EXPIRED", "SCOPE_INVALID", "CANCELLED", "BUSY", "STAGE_INVALID",
  "HOST_INVALID", "SOURCE_INVALID", "DEPENDENCY_INVALID", "ACL_INVALID", "SECRET_INVALID", "JOURNAL_INVALID", "TIMEOUT",
  "PROCESS_FAILED", "REGISTRY_INVALID", "IMAGE_INVALID", "RESOURCE_INVALID", "ISOLATION_UNVERIFIED", "SERVER_INVALID",
  "GRANTS_INVALID", "FIXTURE_INVALID", "RECONCILIATION_INVALID", "ATTESTATION_INVALID", "COMMIT_UNCERTAIN", "ROLLBACK_FAILED",
  "CONNECTION_INVALID", "TLS_INVALID", "CLEANUP_INVALID", "QUARANTINED", "ADAPTER_FAILED"]);
class NativeError extends Error {
  constructor(code) { super("Native harness refused: NATIVE_" + code); this.name = "NativeError"; this.code = "NATIVE_" + code; }
}
function check(value, code) { if (!value) throw new NativeError(code); }
function error(value, fallback = "ADAPTER_FAILED") {
  let code = fallback;
  try { const d = value && Object.getOwnPropertyDescriptor(value, "code");
    if (d && Object.hasOwn(d, "value") && typeof d.value === "string" && CODES.has(d.value.slice(7)) && d.value.startsWith("NATIVE_")) code = d.value.slice(7);
  } catch (_) { /* Never copy native diagnostics, getters, causes or exception identity. */ }
  return new NativeError(code);
}
function data(value) { try { return e.p4bData(value); } catch (_) { throw new NativeError("AUTH_INVALID"); } }
function exact(value, keys, code = "AUTH_INVALID") {
  check(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), code);
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function verifiedOwnerTrust() {
  try {
    exact(OWNER_TRUST, ["owner", "publicKey"], "TRUST_UNAVAILABLE");
    check(OWNER_TRUST.owner === "wmo-appointment-owner-v1" && typeof OWNER_TRUST.publicKey === "string", "TRUST_UNAVAILABLE");
    const match = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=]+(?:\r?\n[A-Za-z0-9+/=]+)*)\r?\n-----END PUBLIC KEY-----(?:\r?\n)?$/.exec(OWNER_TRUST.publicKey);
    check(match, "TRUST_UNAVAILABLE");
    const base64 = match[1].replace(/\r?\n/g, ""), decoded = Buffer.from(base64, "base64");
    check(decoded.toString("base64") === base64, "TRUST_UNAVAILABLE");
    const key = crypto.createPublicKey(OWNER_TRUST.publicKey), der = key.export({ format: "der", type: "spki" });
    check(key.asymmetricKeyType === "ed25519" && der.equals(decoded) && hash(der) === OWNER_KEY_SPKI_SHA256, "TRUST_UNAVAILABLE");
    return OWNER_TRUST;
  } catch (_) { throw new NativeError("TRUST_UNAVAILABLE"); }
}
function verifyReceipt(configuration, receipt, policy) {
  try {
    const c = e.validatePhase4BConfiguration(configuration), r = data(receipt);
    schema.provisioningProfile(c);
    exact(r, ["payload", "signature"]);
    const p = r.payload;
    exact(p, ["version", "owner", "nonce", "issuedAt", "expiresAt", "configuration", "execution", "actions"]);
    check(policy && policy.publicKey && typeof policy.owner === "string" && p.owner === policy.owner && p.version === 1, "AUTH_INVALID");
    check(/^[0-9a-f]{64}$/.test(p.nonce) && p.nonce === policy.nonce && e.same(p.configuration, c), "AUTH_INVALID");
    const now = policy.now, issued = Date.parse(p.issuedAt), expires = Date.parse(p.expiresAt);
    check([p.issuedAt, p.expiresAt].every(v => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)), "AUTH_EXPIRED");
    check(Number.isFinite(now) && Number.isFinite(issued) && Number.isFinite(expires) && issued <= now + 30000 &&
      issued >= now - 900000 && expires > now && expires > issued && expires - issued <= 900000, "AUTH_EXPIRED");
    check(Array.isArray(p.actions) && p.actions.length > 0 && new Set(p.actions).size === p.actions.length && p.actions.every(a => ACTIONS.includes(a)), "AUTH_INVALID");
    const x = p.execution;
    exact(x, ["daemonId", "ownerSid", "dependencyRoot", "dependencyHash", "backendExecutable", "backendHash"]);
    check(/^[a-zA-Z0-9:-]{8,128}$/.test(x.daemonId) && /^S-1-5-21-(?:\d+-){3}\d+$/.test(x.ownerSid) &&
      /^[A-Z]:\\[^<>"|?*\r\n]+\\wmo_appointment_dependencies\\[0-9a-f]{64}$/.test(x.dependencyRoot) &&
      /^[0-9a-f]{64}$/.test(x.dependencyHash) && /^[0-9a-f]{64}$/.test(x.backendHash) &&
      /^[A-Z]:\\[^<>"|?*\r\n]+\\com\.docker\.backend\.exe$/.test(x.backendExecutable), "AUTH_INVALID");
    check(![x.dependencyRoot, x.backendExecutable].some(v => v.split("\\").some(s => s === "." || s === "..")), "AUTH_INVALID");
    check(!/\\(?:\.codex\\worktrees|AndroidStudioProjects)\\/i.test(x.dependencyRoot) &&
      /^C:\\(?:Windows\\Temp|Users\\[^\\]+\\AppData\\Local\\Temp)\\wmo_appointments_[0-9a-f]{32}_secrets$/.test(c.secretDirectory), "AUTH_INVALID");
    check(typeof r.signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(r.signature), "AUTH_INVALID");
    check(Buffer.from(r.signature, "base64").toString("base64") === r.signature, "AUTH_INVALID");
    const key = crypto.createPublicKey(policy.publicKey);
    check(key.asymmetricKeyType === "ed25519" && crypto.verify(null, Buffer.from(canonical(p)), key, Buffer.from(r.signature, "base64")), "AUTH_INVALID");
    return e.freeze(p);
  } catch (caught) { throw error(caught, "AUTH_INVALID"); }
}
function challenge(configuration, policy, kind, fake) {
  const c = e.validatePhase4BConfiguration(configuration); schema.provisioningProfile(c);
  check(kind === "mock" || process.platform === "win32", "HOST_INVALID");
  const nonce = kind === "mock" ? policy.nonce : crypto.randomBytes(32).toString("hex");
  const handle = Object.freeze({ classification: kind === "mock" ? "offline-native-challenge" : "native-challenge", nonce });
  challenges.set(handle, { c, policy, nonce, kind, fake, consumed: false }); return handle;
}
function createNativeChallenge(c) {
  requireOwnerTrust();
  check(process.execArgv.length === 0 && ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_SYSTEM_CA", "NODE_USE_ENV_PROXY"].every(k => !process.env[k]), "HOST_INVALID");
  return challenge(c, OWNER_TRUST, "native");
}
function requireOwnerTrust() {
  check(NATIVE_ACTIVATION_ENABLED === true, "TRUST_UNAVAILABLE");
  verifiedOwnerTrust();
}
function activate(handle, receipt, nativeOnly = true) {
  const ch = challenges.get(handle);
  check(ch && !ch.consumed && (!nativeOnly || ch.kind === "native"), "AUTH_INVALID");
  ch.consumed = true;
  const p = verifyReceipt(ch.c, receipt, { ...ch.policy, nonce: ch.nonce, now: ch.kind === "native" ? Date.now() : ch.policy.now });
  const session = Object.freeze({ classification: ch.kind === "native" ? "native-session" : "offline-native-session" });
  sessions.set(session, { c: ch.c, p, kind: ch.kind, fake: ch.fake, remaining: new Set(p.actions), scopes: new Set(),
    active: null, revoked: false, aborters: new Set(), journal: null, secrets: null, ownedFiles: [], deadline: Date.parse(p.expiresAt) });
  return session;
}
function state(session) { const s = sessions.get(session); check(s && !s.revoked, "SCOPE_INVALID"); return s; }
function describe(session) { const s = state(session); return { configuration: s.c, execution: s.p.execution, kind: s.kind }; }
function scope(session, action) {
  const s = state(session); check(s.remaining.has(action) && !s.active, "SCOPE_INVALID");
  const token = Object.freeze({ classification: s.kind === "mock" ? "offline-native-scope" : "native-scope" });
  const record = { session, action, used: false }; scopes.set(token, record); s.scopes.add(record); return token;
}
function begin(session, token, action) {
  const s = state(session), t = scopes.get(token);
  check(t && t.session === session && t.action === action && !t.used && s.remaining.has(action) && !s.active, "SCOPE_INVALID");
  if (s.kind === "native") check(Date.now() < s.deadline, "AUTH_EXPIRED");
  t.used = true; if (WRITES.has(action)) s.remaining.delete(action); s.active = action;
}
function access(session, actions = ACTIONS) {
  const s = state(session); check(s.active && actions.includes(s.active), "SCOPE_INVALID");
  if (s.kind === "native") check(Date.now() < s.deadline, "AUTH_EXPIRED"); return s;
}
function end(session) { const s = sessions.get(session); if (s) s.active = null; }
function revoke(session) { const s = sessions.get(session); if (s) { s.revoked = true; s.remaining.clear(); s.scopes.forEach(t => { t.used = true; });
  s.aborters.forEach(fn => { try { fn(); } catch (_) { /* Cancellation is best effort; uncertain effects remain quarantined. */ } }); s.aborters.clear(); s.secrets = null; } }
function onCancel(session, callback) { const s = access(session); s.aborters.add(callback); return () => s.aborters.delete(callback); }
function allows(session, actions) { return actions.every(a => state(session).remaining.has(a)); }
function assertAdmission(session, actions) {
  const s = state(session);
  check(!s.active && actions.every(a => ACTIONS.includes(a) && s.remaining.has(a)), "SCOPE_INVALID");
  if (s.kind === "native") check(Date.now() < s.deadline, "AUTH_EXPIRED");
}
function driver(session, name, realFactory) {
  const s = access(session);
  if (s.kind === "mock") { check(s.fake && s.fake[name], "ADAPTER_FAILED"); return s.fake[name]; }
  return realFactory();
}
async function bounded(session, operation, ms = 5000, onTimeout = () => {}) {
  access(session); check(Number.isInteger(ms) && ms > 0 && ms <= 180000, "TIMEOUT");
  let timer;
  try { const result = await Promise.race([Promise.resolve().then(() => { access(session); return operation(); }), new Promise((_, reject) => {
    timer = setTimeout(() => { try { onTimeout(); } catch (_) { /* Cleanup cannot replace the timeout. */ } reject(new NativeError("TIMEOUT")); }, ms);
  })]); access(session); return result; } catch (caught) { throw error(caught); } finally { clearTimeout(timer); }
}
function childEnvironment(source) { return { ...e.buildChildEnvironment(source), WMO_APPOINTMENT_HARNESS_PHASE: "native", COMPOSE_DISABLE_ENV_FILE: "1" }; }

// Private fixed-operation transport. Tests inject fake children in memory; no public command runner is exported.
function runChild(session, transport, executable, args, input = "", timeout = 10000, cleanupMs = 1000) {
  access(session);
  check(typeof executable === "string" && Array.isArray(args) && args.every(v => typeof v === "string" && !v.includes("\0")) &&
    typeof input === "string" && Number.isInteger(timeout) && timeout > 0 && timeout <= 180000 &&
    Number.isInteger(cleanupMs) && cleanupMs > 0 && cleanupMs <= 5000, "PROCESS_FAILED");
  return new Promise((resolve, reject) => {
    let child, timer, stopTimer, output = "", bytes = 0, settled = false, guarded = false, ready = false;
    let dispatching = false, attempted = false, stopping = false, closed = false, exitCode, failure, unregister = () => {};
    const finish = (caught, value) => {
      if (settled) return; settled = true;
      for (const t of [timer, stopTimer]) { try { transport.clearTimer(t); } catch (_) { /* Late callbacks remain inert. */ } }
      try { unregister(); } catch (_) { caught = new NativeError("QUARANTINED"); }
      if (caught) { const safe = error(caught, "PROCESS_FAILED"); if (safe.code === "NATIVE_QUARANTINED") revoke(session); reject(safe); }
      else resolve(value);
    };
    const complete = () => {
      if (!closed || !ready || settled) return;
      finish(failure || (exitCode === 0 ? null : new NativeError("PROCESS_FAILED")), output.trim());
    };
    const stop = caught => {
      if (settled) return; failure ||= error(caught, "PROCESS_FAILED");
      if (!child) { if (!dispatching) finish(failure); return; }
      if (closed) { ready = true; complete(); return; }
      if (!guarded || stopping) return; stopping = true;
      let bounded = true;
      try { stopTimer = transport.setTimer(() => finish(new NativeError("QUARANTINED")), cleanupMs); }
      catch (_) { bounded = false; }
      try { child.kill(); } catch (_) { /* kill acknowledgement is not exit evidence. */ }
      if (closed) { ready = true; complete(); }
      else if (!bounded) finish(new NativeError("QUARANTINED"));
    };
    try {
      // Registration and the operation deadline precede dispatch. Revocation during spawn is handled after its handle arrives.
      unregister = transport.registerCancel(() => stop(new NativeError("CANCELLED")));
      if (settled) { unregister(); return; }
      timer = transport.setTimer(() => stop(new NativeError("TIMEOUT")), timeout);
      if (settled) { transport.clearTimer(timer); return; }
      access(session); attempted = true; dispatching = true;
      child = transport.spawn(executable, args, { shell: false, windowsHide: true, env: childEnvironment(process.env), stdio: ["pipe", "pipe", "pipe"] });
      dispatching = false;
      child.on("error", caught => stop(caught));
      // Keep these listeners after settlement: late pipe errors must never become unhandled events.
      child.stdout.on("error", caught => stop(caught));
      child.stderr.on("error", caught => stop(caught));
      child.stdin.on("error", caught => stop(caught));
      child.on("close", code => { closed = true; exitCode = code; complete(); });
      guarded = true;
      child.stdout.on("data", b => { if (settled) return; bytes += b.length;
        if (bytes > 1024 * 1024) stop(new NativeError("PROCESS_FAILED")); else output += b.toString("utf8"); });
      child.stderr.on("data", b => { if (settled) return; bytes += b.length; if (bytes > 1024 * 1024) stop(new NativeError("PROCESS_FAILED")); });
      ready = true;
      if (failure) stop(failure);
      else if (closed) complete();
      else { access(session); child.stdin.end(input); }
    } catch (caught) {
      dispatching = false;
      if (child) { guarded = true; ready = true; stop(caught); }
      else finish(attempted ? new NativeError("QUARANTINED") : caught);
    }
  });
}

// Fixed PowerShell program; paths and future credentials arrive on stdin, never as script text/argv.
const WINDOWS_PROGRAM = String.raw`
$ErrorActionPreference='Stop'
$x=[Console]::In.ReadToEnd()|ConvertFrom-Json
function Fail { throw 'NATIVE_WINDOWS_REFUSED' }
function InspectPath([string]$p) {
  $v=[IO.Path]::GetFullPath($p); if($v -cne $p){Fail}
  while($v){$item=Get-Item -LiteralPath $v -Force -ErrorAction SilentlyContinue;if($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){Fail};$parent=[IO.Path]::GetDirectoryName($v);if($parent -eq $v){break};$v=$parent}
}
function Acl([string]$p) {
  InspectPath $p; $a=Get-Acl -LiteralPath $p
  if(!$a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $x.sid){Fail}
  $rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if(!$rules.Count){Fail};$owner=$false
  foreach($r in $rules){if($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.IdentityReference.Value -notin @($x.sid,'S-1-5-18')){Fail};if($r.IdentityReference.Value -eq $x.sid -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$owner=$true}}
  if(!$owner){Fail}
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($sid -ne $x.sid){Fail}
switch($x.op){
  'identity' { $cpu=Get-CimInstance -ClassName Win32_Processor|Select-Object -First 1;@{sid=$sid;architecture=(@{9='AMD64';12='ARM64'})[[int]$cpu.Architecture];profile=[Environment]::GetFolderPath('UserProfile')}|ConvertTo-Json -Compress }
  'directory' {
    InspectPath ([IO.Directory]::GetParent($x.path).FullName);if(Test-Path -LiteralPath $x.path){Fail}
    $a=New-Object Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false)
    $who=New-Object Security.Principal.SecurityIdentifier($sid);$a.SetOwner($who)
    foreach($id in @($sid,'S-1-5-18')){$r=New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)}
    $d=New-Object IO.DirectoryInfo($x.path);$d.Create($a);Acl $x.path
    @{ok=$true}|ConvertTo-Json -Compress
  }
  'acl' { Acl $x.path; @{ok=$true}|ConvertTo-Json -Compress }
  'file' {
    Acl ([IO.Path]::GetDirectoryName($x.path));if(Test-Path -LiteralPath $x.path){Fail}
    $a=New-Object Security.AccessControl.FileSecurity;$a.SetAccessRuleProtection($true,$false)
    $who=New-Object Security.Principal.SecurityIdentifier($sid);$a.SetOwner($who)
    foreach($id in @($sid,'S-1-5-18')){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id,'FullControl','Allow')))}
    $f=New-Object IO.FileStream($x.path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,$a)
    try{$b=[Convert]::FromBase64String($x.content);$f.Write($b,0,$b.Length);$f.Flush($true)}finally{$f.Dispose()}
    Acl $x.path;@{ok=$true}|ConvertTo-Json -Compress
  }
  'delete' { Acl $x.path;Remove-Item -LiteralPath $x.path -ErrorAction Stop;@{ok=(!(Test-Path -LiteralPath $x.path))}|ConvertTo-Json -Compress }
  'directory-delete' { Acl $x.path;if(@(Get-ChildItem -LiteralPath $x.path -Force).Count -ne 0){Fail};Remove-Item -LiteralPath $x.path -ErrorAction Stop;@{ok=(!(Test-Path -LiteralPath $x.path))}|ConvertTo-Json -Compress }
  'listener' {
    $rows=@(Get-NetTCPConnection -State Listen -LocalPort $x.port -ErrorAction SilentlyContinue|ForEach-Object{
      $p=Get-Process -Id $_.OwningProcess -ErrorAction Stop;@{address=$_.LocalAddress;port=$_.LocalPort;executable=$p.Path}})
    $rules=@(Get-NetFirewallApplicationFilter -Program $x.backend -ErrorAction Stop|Get-NetFirewallRule|Where-Object{$_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow'}|Get-NetFirewallAddressFilter|ForEach-Object{@{remote=@($_.RemoteAddress)}})
    $profiles=@(Get-NetFirewallProfile|ForEach-Object{@{enabled=$_.Enabled;inbound=[string]$_.DefaultInboundAction}})
    @{listeners=$rows;allowRules=$rules;profiles=$profiles}|ConvertTo-Json -Depth 5 -Compress
  }
  default {Fail}
}`;
function realIO(session) {
  const s = access(session), fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  check(process.platform === "win32" && process.env.SystemRoot === "C:\\Windows", "HOST_INVALID");
  function safePath(p) {
    check(path.win32.isAbsolute(p) && !/[\0\r\n]/.test(p) && path.win32.normalize(p) === p, "HOST_INVALID");
    for (let cursor = p; cursor && cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
      if (fs.existsSync(cursor)) check(!fs.lstatSync(cursor).isSymbolicLink(), "HOST_INVALID");
    }
  }
  async function processCall(executable, args, input = "", timeout = 10000) {
    return runChild(session, { spawn: (...a) => cp.spawn(...a), registerCancel: fn => onCancel(session, fn),
      setTimer: setTimeout, clearTimer: clearTimeout }, executable, args, input, timeout);
  }
  async function windows(op, extra = {}) {
    const result = await processCall(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_PROGRAM, "utf16le").toString("base64")],
      JSON.stringify({ op, sid: s.p.execution.ownerSid, ...extra }));
    try { return JSON.parse(result); } catch (_) { throw new NativeError("HOST_INVALID"); }
  }
  function read(p) { safePath(p); return fs.readFileSync(p); }
  return { windows, read,
    async observeSource() {
      const root = path.resolve(__dirname, "../../../.."), git = "C:\\Program Files\\Git\\cmd\\git.exe";
      const run = args => processCall(git, ["--no-optional-locks", "-C", root, ...args]);
      const [head, branch, top, status] = await Promise.all([run(["rev-parse", "HEAD"]), run(["symbolic-ref", "--short", "HEAD"]), run(["rev-parse", "--show-toplevel"]), run(["status", "--porcelain=v1", "-uall"])]);
      const hashes = Object.fromEntries(Object.keys(e.APPLICATION_FILES).map(f => [f, hash(read(path.join(root, f)))]));
      const manifest = FILES.map(f => ({ path: f, sha256: hash(read(path.join(__dirname, "..", f))) }));
      return { head, branch, root: top.replace(/\\/g, "/"), expectedRoot: root.replace(/\\/g, "/"), clean: status === "", hashes, manifestHash: hash(canonical(manifest)) };
    },
    async binary(p) { return hash(read(p)); },
    async identity() { return windows("identity"); },
    async context() {
      const home = (await windows("identity")).profile;
      check(typeof home === "string" && /^[A-Z]:\\Users\\[^\\]+$/.test(home), "HOST_INVALID");
      return JSON.parse(read(path.join(home, ".docker", "contexts", "meta", hash(s.c.docker.context), "meta.json")).toString("utf8"));
    },
    async directory(p) { return windows("directory", { path: p }); },
    async acl(p) { return windows("acl", { path: p }); },
    async file(p, content) { return windows("file", { path: p, content: Buffer.from(content).toString("base64") }); },
    async remove(p) { return windows("delete", { path: p }); },
    async removeDirectory(p) { return windows("directory-delete", { path: p }); },
    async journal(p, line) { await windows("acl", { path: p }); const fd = fs.openSync(p, "a"); try { fs.writeSync(fd, line + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } },
    async listener() { return windows("listener", { port: s.c.endpoint.port, backend: s.p.execution.backendExecutable }); },
    async dependencies() {
      const root = s.p.execution.dependencyRoot, entries = [];
      function walk(dir, relative = "") { safePath(dir); for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        check(!item.isSymbolicLink() && !/^\.env(?:\.|$)/i.test(item.name), "DEPENDENCY_INVALID");
        const rel = relative ? relative + "/" + item.name : item.name, full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full, rel); else { check(item.isFile(), "DEPENDENCY_INVALID"); entries.push({ path: rel, sha256: hash(read(full)) }); }
      } }
      walk(root); check(hash(canonical(entries)) === s.p.execution.dependencyHash, "DEPENDENCY_INVALID");
      const load = require("node:module").createRequire(path.join(root, "package.json"));
      check(load("mysql2/package.json").version === "3.20.0", "DEPENDENCY_INVALID"); return load("mysql2");
    },
    // Only sibling native adapters receive this driver; it is not a public command runner.
    processCall,
    passwords() { return Object.fromEntries(["root", "setup", "application", "observer"].map(role => [role, crypto.randomBytes(32).toString("base64url")])); }
  };
}
function io(session) { return driver(session, "host", () => realIO(session)); }
async function observe(session) {
  const s = access(session), d = io(session), c = s.c;
  const [identity, nodeHash, dockerHash, backendHash, source] = await Promise.all([d.identity(), d.binary(c.node.executable), d.binary(c.docker.executable), d.binary(s.p.execution.backendExecutable), d.observeSource()]);
  check(identity.sid === s.p.execution.ownerSid && ({ AMD64: "amd64", ARM64: "arm64" })[identity.architecture] === c.image.architecture, "HOST_INVALID");
  check(nodeHash === c.node.executableHash && dockerHash === c.docker.executableHash && backendHash === s.p.execution.backendHash, "HOST_INVALID");
  check(s.kind === "mock" || process.execPath === c.node.executable && process.versions.node === c.node.version, "HOST_INVALID");
  check(source.clean === true && source.head === c.source.harnessCommit && source.branch === "feat/wmo-appointment-service-slot-availability" &&
    source.root === source.expectedRoot && e.same(source.hashes, c.source.applicationFiles) && source.manifestHash === c.source.harnessManifestHash, "SOURCE_INVALID");
  return { ...c.source, clean: true };
}
async function claim(session) {
  const s = access(session, ["provision"]), d = io(session), root = s.c.secretDirectory;
  check(!s.journal, "JOURNAL_INVALID");
  check((await d.directory(root)).ok === true && (await d.acl(root)).ok === true, "ACL_INVALID");
  s.journal = root + "\\journal.jsonl";
  check((await d.file(s.journal, canonical({ version: 1, runId: s.c.runId, nonce: s.p.nonce, harnessCommit: s.c.source.harnessCommit }) + "\n")).ok === true, "JOURNAL_INVALID");
  s.ownedFiles.push(s.journal);
}
async function journal(session, phase, kind, id = null) {
  const s = access(session); check(s.journal && ["intent", "observed", "removed", "uncertain"].includes(phase) &&
    ["image", "container", "network", "volume", "start", "bootstrap", "fixture", "attest", "secrets"].includes(kind) &&
    (id === null || typeof id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(id)), "JOURNAL_INVALID");
  await io(session).journal(s.journal, canonical({ phase, kind, id }));
}
async function credentials(session) {
  const s = access(session, ["provision"]), d = io(session);
  check(s.journal && !s.secrets && (await d.acl(s.c.secretDirectory)).ok === true, "ACL_INVALID");
  await journal(session, "intent", "secrets");
  const secrets = await d.passwords();
  exact(secrets, ["root", "setup", "application", "observer"], "SECRET_INVALID");
  check(Object.values(secrets).every(v => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v)) && new Set(Object.values(secrets)).size === 4, "SECRET_INVALID");
  for (const [name, content] of [["root-password", secrets.root], ["root-client", "[client]\nuser=root\npassword=" + secrets.root + "\n"]]) {
    const p = s.c.secretDirectory + "\\" + name;
    check((await d.file(p, content)).ok === true && (await d.acl(p)).ok === true, "ACL_INVALID"); s.ownedFiles.push(p);
  }
  s.secrets = secrets; await journal(session, "observed", "secrets");
}
function secret(session, role) { const s = access(session, ["provision", "verify", "attest", "connect-check"]); check(s.secrets && Object.hasOwn(s.secrets, role), "SECRET_INVALID"); return s.secrets[role]; }
async function verifyListener(session) {
  const s = access(session), o = data(await io(session).listener());
  exact(o, ["listeners", "allowRules", "profiles"], "ISOLATION_UNVERIFIED");
  check(Array.isArray(o.listeners) && o.listeners.length > 0 && o.listeners.every(v => v.address === "127.0.0.1" && v.port === s.c.endpoint.port && v.executable === s.p.execution.backendExecutable), "ISOLATION_UNVERIFIED");
  check(Array.isArray(o.profiles) && o.profiles.length > 0 && o.profiles.every(v => v.enabled === true && v.inbound === "Block") &&
    Array.isArray(o.allowRules) && o.allowRules.every(v => Array.isArray(v.remote) && v.remote.length > 0 && v.remote.every(a => ["127.0.0.1", "127.0.0.1/32", "::1", "::1/128"].includes(a))), "ISOLATION_UNVERIFIED");
}
async function deleteSecrets(session) {
  const s = access(session, ["teardown"]), d = io(session);
  check(s.ownedFiles.length > 0, "CLEANUP_INVALID");
  for (const p of [...s.ownedFiles].reverse()) { check((await d.acl(p)).ok === true && (await d.remove(p)).ok === true, "CLEANUP_INVALID"); }
  check((await d.removeDirectory(s.c.secretDirectory)).ok === true, "CLEANUP_INVALID");
  s.ownedFiles = []; s.secrets = null;
}
async function dockerInvoke(session, token) {
  access(session);
  const request = require("./nativeDocker.cjs").readCommand(session, token);
  return io(session).processCall(request.executable, request.args, request.input, request.timeout);
}
async function contextMetadata(session) { access(session); return io(session).context(); }
async function loadMysql(session) { access(session); return io(session).dependencies(); }
function testDriver(session, name) { const s = access(session); check(s.kind === "mock" && s.fake && s.fake[name], "ADAPTER_FAILED"); return s.fake[name]; }
module.exports = { NativeError, check, error, data, exact, canonical, hash, ACTIONS, FILES, createNativeChallenge, activate, requireOwnerTrust,
  describe, scope, begin, access: (session, actions) => { access(session, actions); }, end, revoke, bounded, onCancel, allows, assertAdmission, childEnvironment, observe, claim, journal, credentials, secret,
  verifyListener, deleteSecrets, dockerInvoke, contextMetadata, loadMysql, testDriver };
// This path produces only privately branded MOCK sessions. It cannot provision a native driver.
module.exports.testing = Object.freeze({ challenge: (c, policy, fake) => challenge(c, policy, "mock", fake),
  activate: (c, r) => { check(challenges.get(c)?.kind === "mock", "AUTH_INVALID"); return activate(c, r, false); }, verifyReceipt });
