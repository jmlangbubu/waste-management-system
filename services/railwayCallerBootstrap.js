"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { privateDatabaseOptions } = require("../config/railwayStaging");
const { databasePolicy } = require("../config/stagingSafety");
const { parseCallerCredentials } = require("./cloudRunAuth");
function unavailable() {
  const error = new Error("Staging caller credential bootstrap unavailable.");
  error.code = "STAGING_CALLER_BOOTSTRAP_UNAVAILABLE";
  return error;
}
function prepareRuntimeCredentials({
  env = process.env, filesystem = fs, runtime = process, platform = process.platform,
  temporaryRoot = os.tmpdir()
} = {}) {
  if (env.CLOUD_RUN_CALLER_CREDENTIALS_JSON === undefined) return { cleanup() {} };
  let directory, file, fd;
  const cleanup = () => {
    let failed = false;
    if (file) { try { filesystem.unlinkSync(file); file = undefined; } catch (error) { if (error.code === "ENOENT") file = undefined; else failed = true; } }
    if (directory && !file) { try { filesystem.rmdirSync(directory); directory = undefined; } catch (_) { failed = true; } }
    if (failed) throw unavailable();
  };
  const exitCleanup = () => { try { cleanup(); } catch (_) { /* No secret-bearing diagnostics on shutdown. */ } };
  try {
    privateDatabaseOptions(databasePolicy(env), env);
    if (platform !== "linux" || env.STAGING_DATABASE_TRANSPORT !== "railway_private"
        || env.CLOUD_RUN_AUTH_MODE !== "iam" || env.CLOUD_RUN_CALLER_CREDENTIALS_FILE) throw unavailable();
    const raw = env.CLOUD_RUN_CALLER_CREDENTIALS_JSON;
    delete env.CLOUD_RUN_CALLER_CREDENTIALS_JSON;
    parseCallerCredentials(raw, env);
    const app = filesystem.realpathSync(path.resolve(__dirname, ".."));
    const temp = filesystem.realpathSync(temporaryRoot);
    const relative = path.relative(app, temp);
    if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw unavailable();
    directory = filesystem.mkdtempSync(path.join(temp, "wmo-staging-caller-"));
    filesystem.chmodSync(directory, 0o700);
    if ((filesystem.statSync(directory).mode & 0o777) !== 0o700) throw unavailable();
    file = path.join(directory, "caller.json");
    fd = filesystem.openSync(file, "wx", 0o600);
    if ((filesystem.fstatSync(fd).mode & 0o777) !== 0o600) throw unavailable();
    filesystem.writeFileSync(fd, raw, "utf8");
    filesystem.fsyncSync(fd);
    filesystem.closeSync(fd); fd = undefined;
    env.CLOUD_RUN_CALLER_CREDENTIALS_FILE = file;
    runtime.once("exit", exitCleanup);
    runtime.once("SIGTERM", () => { exitCleanup(); runtime.exit(143); });
    runtime.once("SIGINT", () => { exitCleanup(); runtime.exit(130); });
    return { cleanup };
  } catch (_) {
    if (fd !== undefined) { try { filesystem.closeSync(fd); } catch (_) {} }
    exitCleanup();
    delete env.CLOUD_RUN_CALLER_CREDENTIALS_JSON;
    throw unavailable();
  }
}
module.exports = { prepareRuntimeCredentials };
