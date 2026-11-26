"use strict";

const h = require("./nativeHost.cjs"), e = require("./environment.cjs"), recipes = require("./disposable.cjs");
const { performance } = require("node:perf_hooks");
const commands = new WeakMap(), adapters = new WeakMap();
const ID = /^[0-9a-f]{64}$/, DIGEST = /^sha256:[0-9a-f]{64}$/;
const REGISTRY = "https://registry-1.docker.io", AUTH = "https://auth.docker.io";
const CONFIG_CDN = "https://production.cloudfront.docker.com";
const REDIRECT_CONFIG_DIGEST = "sha256:3121b912b942b8b46646b1f64c955958b8353e8902693ba962a2e37d2d3224bd";
const configRedirects = new WeakMap();
// Daemon metadata only; this does not configure Node transport or attest upstream routing/isolation.
function approvedDaemonProxy(httpProxy, httpsProxy) {
  const empty = value => value === undefined || value === "";
  return empty(httpProxy) && empty(httpsProxy) || typeof httpProxy === "string" && httpProxy === httpsProxy &&
    (httpProxy === "http.docker.internal:3128" || httpProxy === "http://http.docker.internal:3128");
}
function remaining(deadline) {
  const ms = Math.floor(deadline - performance.now()); h.check(ms > 0, "TIMEOUT"); return Math.min(ms, 10000);
}
function configRedirect(session, reply, authorization, deadline) {
  try {
    const location = reply.headers.location;
    h.check(reply.locationCount === 1 && typeof location === "string" && location.length <= 16384 &&
      !/[^\x21-\x7e]|\\|#/.test(location) && !/%(?![0-9a-f]{2})/i.test(location) &&
      typeof authorization === "string" && authorization.startsWith("Bearer "), "REGISTRY_INVALID");
    const u = new URL(location), authority = /^https:\/\/([^/?#]+)/.exec(location);
    h.check(u.origin === CONFIG_CDN && u.protocol === "https:" && u.hostname === "production.cloudfront.docker.com" &&
      !u.username && !u.password && !u.hash && !u.port && authority &&
      [u.hostname, u.hostname + ":443"].includes(authority[1]), "REGISTRY_INVALID");
    // Do not reinterpret a signed URL through parser-normalized paths; only explicit default-port normalization is allowed.
    h.check(u.href === CONFIG_CDN + location.slice(authority[0].length), "REGISTRY_INVALID");
    // Do not delegate URLs embedding registry credentials, including percent-encoded forms.
    const token = authorization.slice(7); let decoded = location, complete = false;
    for (let i = 0; i < 4; i++) {
      h.check(!decoded.includes(token) && !/[\\\x00-\x1f\x7f]/.test(decoded), "REGISTRY_INVALID");
      const next = decoded.replace(/%([0-9a-f]{2})/ig, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (next === decoded) { complete = true; break; } decoded = next;
    }
    h.check(complete, "REGISTRY_INVALID"); remaining(deadline);
    const permit = Object.freeze({}); configRedirects.set(permit, { session, url: u.href, deadline }); return { url: u.href, permit };
  } catch (caught) { throw h.error(caught, "REGISTRY_INVALID"); }
}
function readCommand(session, token) { const v = commands.get(token); h.check(v && v.session === session, "SCOPE_INVALID"); return v.request; }
function parse(text, code = "RESOURCE_INVALID") { try { return JSON.parse(text); } catch (_) { throw new h.NativeError(code); } }
function singleton(text) { const v = parse(text); h.check(Array.isArray(v) && v.length === 1, "RESOURCE_INVALID"); return v[0]; }
// Normalize only execution settings, never diagnostics. The expected values come from digest-verified image bytes.
function startupSettings(config, code) {
  h.check(config && typeof config === "object" && !Array.isArray(config), code);
  const strings = name => {
    const values = config[name] == null ? [] : config[name];
    h.check(Array.isArray(values) && values.every(v => typeof v === "string" && !v.includes("\0")), code); return [...values];
  };
  const text = name => { const value = config[name] == null ? "" : config[name];
    h.check(typeof value === "string" && !value.includes("\0"), code); return value; };
  const env = new Map();
  for (const value of strings("Env")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(value);
    h.check(match && !env.has(match[1]), code); env.set(match[1], value);
  }
  const health = config.Healthcheck;
  let healthcheck = null;
  if (health != null) {
    h.check(typeof health === "object" && !Array.isArray(health) &&
      Object.keys(health).every(k => ["Test", "Interval", "Timeout", "StartPeriod", "StartInterval", "Retries"].includes(k)), code);
    h.check(Array.isArray(health.Test) && health.Test.length > 0 &&
      health.Test.every(v => typeof v === "string" && !v.includes("\0")), code);
    healthcheck = { Test: [...health.Test] };
    for (const key of ["Interval", "Timeout", "StartPeriod", "StartInterval", "Retries"]) {
      const value = health[key] == null ? 0 : health[key]; h.check(Number.isSafeInteger(value) && value >= 0, code); healthcheck[key] = value;
    }
  }
  h.check(config.ArgsEscaped == null || typeof config.ArgsEscaped === "boolean", code);
  return { Env: [...env.values()].sort(), Entrypoint: strings("Entrypoint"), Cmd: strings("Cmd"), User: text("User"),
    WorkingDir: text("WorkingDir"), StopSignal: text("StopSignal"), Shell: strings("Shell"), OnBuild: strings("OnBuild"),
    ArgsEscaped: config.ArgsEscaped ?? false, Healthcheck: healthcheck };
}
// The request is not complete until its close event and response EOF have been observed.
function requestBytes(session, url, headers, transport, timeout = 10000, cleanupMs = 1000, permit) {
  h.access(session);
  let u; try { u = new URL(url); } catch (_) { throw new h.NativeError("REGISTRY_INVALID"); }
  const delegated = configRedirects.get(permit);
  const allowed = u.origin === CONFIG_CDN ? delegated && delegated.session === session && delegated.url === url &&
    headers && Object.keys(headers).length === 1 && headers["Accept-Encoding"] === "identity" : [REGISTRY, AUTH].includes(u.origin) && permit === undefined;
  h.check(allowed && u.protocol === "https:" && !u.username && !u.password &&
    Number.isInteger(timeout) && timeout > 0 && timeout <= 10000 && Number.isInteger(cleanupMs) && cleanupMs > 0 && cleanupMs <= 5000, "REGISTRY_INVALID");
  if (delegated) { timeout = Math.min(timeout, remaining(delegated.deadline)); configRedirects.delete(permit); }
  return new Promise((resolve, reject) => {
    let req, response, timer, stopTimer, settled = false, guarded = false, ready = false, dispatching = false, attempted = false;
    let closed = false, ended = false, responseClosed = false, stopping = false, failure, size = 0, unregister = () => {};
    const parts = [];
    const finish = (caught, value) => {
      if (settled) return; settled = true;
      for (const t of [timer, stopTimer]) { try { transport.clearTimer(t); } catch (_) { /* Late callbacks are inert. */ } }
      try { unregister(); } catch (_) { caught = new h.NativeError("QUARANTINED"); }
      try { transport.agent.destroy(); } catch (_) { caught = new h.NativeError("QUARANTINED"); }
      if (caught) { const safe = h.error(caught, "REGISTRY_INVALID"); if (safe.code === "NATIVE_QUARANTINED") h.revoke(session); reject(safe); }
      else resolve(value);
    };
    const complete = () => {
      if (!ready || !closed || settled) return;
      if (failure && (!response || ended || responseClosed)) finish(failure);
      else if (!failure && ended) finish(null, { origin: u.origin, status: response.statusCode, headers: response.headers,
        locationCount: Array.isArray(response.rawHeaders) && response.rawHeaders.length % 2 === 0 && response.rawHeaders.every(v => typeof v === "string") ?
          response.rawHeaders.reduce((n, v, i) => n + (i % 2 === 0 && v.toLowerCase() === "location" ? 1 : 0), 0) : -1, body: Buffer.concat(parts) });
    };
    const stop = caught => {
      if (settled) return; failure ||= h.error(caught, "REGISTRY_INVALID");
      if (!req) { if (!dispatching) finish(failure); return; }
      if (closed && (!response || ended || responseClosed)) { ready = true; complete(); return; }
      if (!guarded || stopping) return; stopping = true;
      let bounded = true;
      try { stopTimer = transport.setTimer(() => finish(new h.NativeError("QUARANTINED")), cleanupMs); } catch (_) { bounded = false; }
      try { req.destroy(); } catch (_) { /* Await close, never infer it from destroy(). */ }
      try { if (response && !ended && !responseClosed) response.destroy(); } catch (_) { /* Close deadline owns uncertainty. */ }
      complete(); if (!settled && !bounded) finish(new h.NativeError("QUARANTINED"));
    };
    const receive = value => {
      response = value;
      response.on("error", caught => stop(caught));
      response.on("aborted", () => stop(new h.NativeError("REGISTRY_INVALID")));
      response.on("close", () => { responseClosed = true; if (!ended) stop(new h.NativeError("REGISTRY_INVALID")); complete(); });
      response.on("data", b => { if (settled) return; size += b.length;
        if (size > 65536) stop(new h.NativeError("REGISTRY_INVALID")); else parts.push(b); });
      response.on("end", () => { if (response.complete !== true) { stop(new h.NativeError("REGISTRY_INVALID")); return; } ended = true; complete(); });
    };
    try {
      unregister = transport.registerCancel(() => stop(new h.NativeError("CANCELLED")));
      if (settled) { unregister(); return; }
      timer = transport.setTimer(() => stop(new h.NativeError("TIMEOUT")), timeout);
      if (settled) { transport.clearTimer(timer); return; }
      h.access(session); attempted = true; dispatching = true;
      req = transport.request(u, { method: "GET", headers, rejectUnauthorized: true, agent: transport.agent }, receive);
      dispatching = false;
      req.on("error", caught => stop(caught));
      req.on("close", () => { closed = true; if (!response) failure ||= new h.NativeError("REGISTRY_INVALID"); complete(); });
      guarded = true; ready = true;
      if (failure) stop(failure); else if (closed) complete(); else { h.access(session); req.end(); }
    } catch (caught) {
      dispatching = false;
      if (req) { guarded = true; ready = true; stop(caught); }
      else finish(attempted ? new h.NativeError("QUARANTINED") : caught);
    }
  });
}
function realRegistry(session) {
  return { async request(url, headers, timeout = 10000, permit) {
    const https = require("node:https");
    return requestBytes(session, url, headers, { request: (...a) => https.request(...a),
      agent: new https.Agent({ keepAlive: false, rejectUnauthorized: true }), registerCancel: fn => h.onCancel(session, fn),
      setTimer: setTimeout, clearTimer: clearTimeout }, timeout, 1000, permit);
  } };
}
function createDocker(session) {
  const { configuration: c, execution: x, kind } = h.describe(session), names = e.runNames(c.runId);
  let hostVerified = false, imageVerified = false, imageLabels = {}, imageStartup, owned = null, volumeCreated = null, uncertain = false, startAttempted = false, count = 0;
  const created = new Map();
  async function call(args, input = "", timeout = 10000) {
    h.access(session);
    const token = Object.freeze({});
    commands.set(token, { session, request: Object.freeze({ executable: c.docker.executable,
      args: Object.freeze(["--config", c.secretDirectory, "--host", c.docker.endpoint, ...args]), input, timeout }) });
    count++;
    try {
      // The real child wrapper includes its own close deadline; do not race it with an earlier duplicate timer.
      const result = kind === "mock" ? await h.bounded(session, () => h.dockerInvoke(session, token), timeout) : await h.dockerInvoke(session, token);
      h.access(session); return result;
    }
    finally { commands.delete(token); }
  }
  async function absent(type, name) {
    const args = type === "container" ? ["container", "ls", "--all", "--no-trunc", "--filter", "name=^/" + name + "$", "--format", "{{json .}}"] :
      [type, "ls", "--filter", "name=" + name, "--format", "{{json .}}"];
    h.check((await call(args)) === "", "RESOURCE_INVALID");
  }
  async function observeHost() {
    h.access(session);
    const meta = h.data(await h.contextMetadata(session));
    h.check(meta.Name === c.docker.context && meta.Endpoints?.docker?.Host === c.docker.endpoint && meta.Endpoints.docker.SkipTLSVerify !== true, "HOST_INVALID");
    const version = parse(await call(["version", "--format", "{{json .Server}}"]), "HOST_INVALID");
    const info = parse(await call(["info", "--format", "{{json .}}"]), "HOST_INVALID");
    h.check(info.ID === x.daemonId && info.OSType === "linux" && version.Os === "linux" &&
      ({ x86_64: "amd64", aarch64: "arm64", amd64: "amd64", arm64: "arm64" })[info.Architecture] === c.image.architecture &&
      version.Arch === c.image.architecture && /^\d+\.\d+\.\d+$/.test(version.Version) && Number(version.Version.split(".")[0]) >= 28, "HOST_INVALID");
    h.check(!info.RegistryConfig?.Mirrors?.length && approvedDaemonProxy(info.HTTPProxy, info.HTTPSProxy), "HOST_INVALID");
    h.check(!info.RegistryConfig?.IndexConfigs?.["docker.io"] || info.RegistryConfig.IndexConfigs["docker.io"].Secure === true, "HOST_INVALID");
    hostVerified = true; return { daemonId: info.ID, engineVersion: version.Version };
  }
  async function registry() {
    h.access(session, ["provision"]); h.check(hostVerified, "STAGE_INVALID");
    const transport = kind === "mock" ? h.testDriver(session, "registry") : realRegistry(session);
    const acceptable = (r, origin, statuses, empty = false) => {
      h.check(r.origin === origin && statuses.includes(r.status) && (!r.headers["content-encoding"] || r.headers["content-encoding"] === "identity") &&
        Buffer.isBuffer(r.body) && (empty || r.body.length > 0) && r.body.length <= 65536, "REGISTRY_INVALID");
    };
    async function get(url, headers = {}, deadline = performance.now() + 10000, configOnly = false) {
      h.check((url.startsWith(REGISTRY + "/v2/library/mysql/") || url.startsWith(AUTH + "/token?")) && !url.includes("#"), "REGISTRY_INVALID");
      const timeout = remaining(deadline), request = () => transport.request(url, { "Accept-Encoding": "identity", ...headers }, timeout);
      const r = kind === "mock" ? await h.bounded(session, request, timeout) : await request(); h.access(session); remaining(deadline);
      if (r.status === 307) {
        h.check(configOnly && c.image.configDigest === REDIRECT_CONFIG_DIGEST && url === REGISTRY + "/v2/library/mysql/blobs/" + REDIRECT_CONFIG_DIGEST &&
          authorization && headers.Authorization === authorization, "REGISTRY_INVALID");
        acceptable(r, REGISTRY, [307], true);
        const target = configRedirect(session, r, authorization, deadline);
        try {
          const budget = remaining(deadline);
          // Fresh minimal headers. Registry authentication and cookies never cross the origin boundary.
          const fetch = () => transport.request(target.url, { "Accept-Encoding": "identity" }, budget, target.permit);
          const blob = kind === "mock" ? await h.bounded(session, fetch, budget) : await fetch(); h.access(session); remaining(deadline);
          acceptable(blob, CONFIG_CDN, [200]);
          h.check(!blob.headers.location && (blob.locationCount ?? 0) === 0, "REGISTRY_INVALID"); return blob;
        } finally { configRedirects.delete(target.permit); }
      }
      acceptable(r, new URL(url).origin, [200, 401]);
      h.check(!r.headers.location && (r.locationCount ?? 0) === 0, "REGISTRY_INVALID"); return r;
    }
    const accept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
    const indexURL = REGISTRY + "/v2/library/mysql/manifests/9.7.2-oraclelinux9";
    let initial = await get(indexURL, { Accept: accept }), authorization;
    if (initial.status === 401) {
      const challenge = initial.headers["www-authenticate"];
      h.check(typeof challenge === "string" && /^Bearer realm="https:\/\/auth\.docker\.io\/token",service="registry\.docker\.io",scope="repository:library\/mysql:pull"$/.test(challenge), "REGISTRY_INVALID");
      const tokenResponse = await get(AUTH + "/token?service=registry.docker.io&scope=repository%3Alibrary%2Fmysql%3Apull");
      h.check(tokenResponse.status === 200, "REGISTRY_INVALID"); const token = parse(tokenResponse.body.toString("utf8"), "REGISTRY_INVALID").token;
      h.check(typeof token === "string" && /^[A-Za-z0-9._~-]{20,16384}$/.test(token), "REGISTRY_INVALID"); authorization = "Bearer " + token;
      initial = await get(indexURL, { Accept: accept, Authorization: authorization });
    }
    h.check(initial.status === 200, "REGISTRY_INVALID");
    const headers = authorization ? { Accept: accept, Authorization: authorization } : { Accept: accept };
    const manifest = await get(REGISTRY + "/v2/library/mysql/manifests/" + c.image.platformDigest, headers);
    const config = await get(REGISTRY + "/v2/library/mysql/blobs/" + c.image.configDigest, headers, performance.now() + 10000, true);
    h.check(manifest.status === 200 && config.status === 200, "REGISTRY_INVALID");
    const responses = [initial, manifest, config], digests = [c.image.indexDigest, c.image.platformDigest, c.image.configDigest];
    const texts = responses.map((r, i) => {
      h.check("sha256:" + h.hash(r.body) === digests[i] && (!r.headers["docker-content-digest"] || r.headers["docker-content-digest"] === digests[i]), "IMAGE_INVALID");
      const text = r.body.toString("utf8"); h.check(Buffer.from(text).equals(r.body), "IMAGE_INVALID"); return text;
    });
    try { recipes.verifyRegistryProof(c, { indexRaw: texts[0], manifestRaw: texts[1], configRaw: texts[2] }); }
    catch (_) { throw new h.NativeError("IMAGE_INVALID"); }
    const verifiedConfig = parse(texts[2], "IMAGE_INVALID").config;
    imageStartup = startupSettings(verifiedConfig, "IMAGE_INVALID");
    // The reviewed create command overrides CMD with flags and requires the image's original entrypoint.
    h.check(imageStartup.Entrypoint.length > 0 && imageStartup.Entrypoint[0].length > 0, "IMAGE_INVALID");
    const overrides = new Map([["MYSQL_ROOT_HOST", "MYSQL_ROOT_HOST=localhost"],
      ["MYSQL_ROOT_PASSWORD_FILE", "MYSQL_ROOT_PASSWORD_FILE=/run/secrets/wmo-root-password"]]);
    for (const value of imageStartup.Env) { const key = value.slice(0, value.indexOf("=")); if (!overrides.has(key)) overrides.set(key, value); }
    imageStartup = e.freeze({ ...imageStartup, Env: [...overrides.values()].sort(), Cmd: ["--mysqlx=0"] });
    imageLabels = verifiedConfig.Labels || {};
    h.check(imageLabels && typeof imageLabels === "object" && !Array.isArray(imageLabels) && Object.entries(imageLabels).every(([key, value]) =>
      !key.startsWith("wmo.test.") && typeof value === "string"), "IMAGE_INVALID");
    imageVerified = true; return { indexDigest: digests[0], platformDigest: digests[1], configDigest: digests[2] };
  }
  async function effect(resource, args, expected) {
    await h.journal(session, "intent", resource);
    try {
      const id = await call(args);
      h.check(expected(id), "RESOURCE_INVALID"); created.set(resource, id);
      await h.journal(session, "observed", resource, id); return id;
    } catch (caught) { uncertain = true; await h.journal(session, "uncertain", resource).catch(() => {}); throw h.error(caught); }
  }
  async function create() {
    h.access(session, ["provision"]); h.check(hostVerified && imageVerified && !created.size, "STAGE_INVALID");
    await observeHost();
    for (const type of ["container", "network", "volume"]) await absent(type, names[type]);
    await h.journal(session, "intent", "image");
    await call(["image", "pull", "--platform", "linux/" + c.image.architecture, e.IMAGE + "@" + c.image.platformDigest], "", 180000);
    const image = singleton(await call(["image", "inspect", e.IMAGE + "@" + c.image.platformDigest]));
    h.check(image.Id === c.image.configDigest && image.Os === "linux" && image.Architecture === c.image.architecture &&
      image.RepoDigests?.some(d => d.endsWith("@" + c.image.platformDigest)), "IMAGE_INVALID");
    const plan = recipes.commandPlan(c);
    const args = plan.create.map(v => v.args.slice(2));
    // Internal + isolated removes the bridge's host gateway. Unsupported host access must STOP, never broaden networking.
    args[0].splice(4, 0, "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated");
    await effect("network", args[0], id => ID.test(id));
    const volumeStarted = Date.now();
    await effect("volume", args[1], id => id === names.volume);
    const v = singleton(await call(["volume", "inspect", names.volume]));
    h.check(v.Name === names.volume && v.Driver === "local" && v.Scope === "local" && typeof v.CreatedAt === "string" && Number.isFinite(Date.parse(v.CreatedAt)) &&
      (kind === "mock" || Date.parse(v.CreatedAt) >= volumeStarted - 2000 && Date.parse(v.CreatedAt) <= Date.now() + 2000) &&
      !Object.keys(v.Options || {}).length && e.same(v.Labels, { "wmo.test.purpose": e.PURPOSE, "wmo.test.run": c.runId }), "RESOURCE_INVALID"); volumeCreated = v.CreatedAt;
    await effect("container", args[2], id => ID.test(id));
  }
  async function start() {
    h.access(session, ["provision"]); h.check(!uncertain && !startAttempted && created.size === 3, "STAGE_INVALID"); startAttempted = true;
    // Observations detect drift; they cannot eliminate every external change after the final observation.
    const admitted = await resourceSnapshot(true);
    await h.journal(session, "intent", "start", created.get("container"));
    const fresh = await resourceSnapshot(true);
    h.check(e.same(admitted.raw, fresh.raw), "RESOURCE_INVALID");
    try {
      h.check(await call(["container", "start", created.get("container")]) === created.get("container"), "RESOURCE_INVALID");
      const result = await inspect(); await h.journal(session, "observed", "start", created.get("container")); return result;
    } catch (caught) { uncertain = true; await h.journal(session, "uncertain", "start", created.get("container")).catch(() => {}); throw h.error(caught); }
  }
  async function resourceSnapshot(stopped) {
    h.access(session); h.check(!uncertain && created.size === 3, "RESOURCE_INVALID"); await observeHost();
    const container = singleton(await call(["container", "inspect", created.get("container")]));
    const network = singleton(await call(["network", "inspect", created.get("network")]));
    const volume = singleton(await call(["volume", "inspect", created.get("volume")]));
    const effective = startupSettings(container.Config, "RESOURCE_INVALID"), argv = [...effective.Entrypoint, ...effective.Cmd];
    h.check(imageStartup && e.same(effective, imageStartup) && container.Config.Image === e.IMAGE + "@" + c.image.platformDigest &&
      container.Path === argv[0] && e.same(container.Args, argv.slice(1)) &&
      !container.Config.Tty && !container.Config.OpenStdin && !container.Config.StdinOnce && !container.Config.NetworkDisabled &&
      (container.Config.StopTimeout == null), "RESOURCE_INVALID");
    const networkEntries = Object.entries(container.NetworkSettings?.Networks || {});
    h.check(container.State && container.State.Running === !stopped && container.State.Status === (stopped ? "created" : "running") &&
      !container.State.Paused && !container.State.Restarting && !container.State.Dead &&
      e.same(container.Config.Labels, { ...imageLabels, "wmo.test.purpose": e.PURPOSE, "wmo.test.run": c.runId }) && container.Image === c.image.configDigest &&
      container.Id === created.get("container") && container.Name === "/" + names.container && networkEntries.length <= 1 &&
      (stopped || networkEntries.length === 1) && networkEntries.every(([name, value]) => name === names.network &&
        (value.NetworkID === network.Id || stopped && !value.NetworkID) && !value.GlobalIPv6Address) &&
      [names.network, network.Id].includes(container.HostConfig.NetworkMode) && e.same(container.Config.Cmd, ["--mysqlx=0"]), "RESOURCE_INVALID");
    h.check(network.Id === created.get("network") && network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated" &&
      network.Name === names.network && network.Driver === "bridge" && network.Internal === true && network.EnableIPv6 === false &&
      e.same(network.Labels, { "wmo.test.purpose": e.PURPOSE, "wmo.test.run": c.runId }) &&
      Object.keys(network.Containers || {}).every(id => id === container.Id) &&
      volume.Name === created.get("volume") && volume.Driver === "local" && volume.Scope === "local" && volume.CreatedAt === volumeCreated &&
      e.same(volume.Labels, { "wmo.test.purpose": e.PURPOSE, "wmo.test.run": c.runId }) && !Object.keys(volume.Options || {}).length, "RESOURCE_INVALID");
    const ports = [];
    for (const [target, bindings] of Object.entries(container.NetworkSettings.Ports || {})) for (const p of bindings || []) {
      h.check(target === "3306/tcp", "RESOURCE_INVALID"); ports.push({ host: p.HostIp, port: Number(p.HostPort), containerPort: 3306, protocol: "tcp" });
    }
    h.check(e.same(container.HostConfig.PortBindings, { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: String(c.endpoint.port) }] }) &&
      container.HostConfig.NanoCpus === 2e9 && container.HostConfig.Memory === 1073741824 && container.HostConfig.RestartPolicy.Name === "no" &&
      !container.HostConfig.Binds?.length && !Object.keys(container.HostConfig.Tmpfs || {}).length && !container.HostConfig.Privileged &&
      !container.HostConfig.CapAdd?.length && !container.HostConfig.Devices?.length && !container.HostConfig.PidMode, "RESOURCE_INVALID");
    const observed = [
      { kind: "container", id: container.Id, name: names.container, labels: { "wmo.test.purpose": container.Config.Labels["wmo.test.purpose"], "wmo.test.run": container.Config.Labels["wmo.test.run"] }, imageConfig: container.Image,
        networkId: network.Id, ports, mounts: container.Mounts.map(m => ({ type: m.Type, source: m.Type === "volume" ? m.Name : m.Source,
          target: m.Destination, readOnly: !m.RW })), privileged: container.HostConfig.Privileged, networkMode: "bridge",
        restart: container.HostConfig.RestartPolicy.Name, cpus: container.HostConfig.NanoCpus / 1e9, memory: container.HostConfig.Memory, mysqlx: false },
      { kind: "network", id: network.Id, name: network.Name, labels: network.Labels, driver: network.Driver, internal: network.Internal,
        ipv6: network.EnableIPv6, members: Object.keys(network.Containers || {}) },
      { kind: "volume", id: volume.Name, name: volume.Name, labels: volume.Labels, driver: volume.Driver, scope: volume.Scope }
    ];
    h.check(e.same(observed[0].mounts, [
      { type: "volume", source: names.volume, target: "/var/lib/mysql", readOnly: false },
      { type: "bind", source: c.secretDirectory + "\\root-password", target: "/run/secrets/wmo-root-password", readOnly: true },
      { type: "bind", source: c.secretDirectory + "\\root-client", target: "/run/secrets/wmo-root-client", readOnly: true }
    ]) && (stopped ? ports.length === 0 || e.same(ports, [c.endpoint]) : e.same(ports, [c.endpoint])), "RESOURCE_INVALID");
    if (!stopped) { try { e.validatePhase4BResources(c, observed); } catch (_) { throw new h.NativeError("RESOURCE_INVALID"); } owned = observed; }
    return { raw: { container, network, volume }, observed };
  }
  async function inspect() {
    const { observed } = await resourceSnapshot(false);
    await h.verifyListener(session);
    const routes = await readFile("routes");
    h.check(routes.split(/\r?\n/).slice(1).filter(Boolean).every(line => {
      const cells = line.trim().split(/\s+/); return cells.length >= 8 && cells[1] !== "00000000" && cells[2] === "00000000";
    }), "ISOLATION_UNVERIFIED");
    const ipv6 = await readFile("ipv6");
    h.check(ipv6.split(/\r?\n/).filter(Boolean).every(line => line.trim().split(/\s+/).at(-1) === "lo"), "ISOLATION_UNVERIFIED");
    return e.freeze(observed);
  }
  async function readFile(kindName) {
    h.access(session); h.check(created.has("container"), "RESOURCE_INVALID");
    const paths = { os: "/etc/os-release", routes: "/proc/net/route", ipv6: "/proc/net/ipv6_route", ca: "/var/lib/mysql/ca.pem", certificate: "/var/lib/mysql/server-cert.pem" };
    h.check(Object.hasOwn(paths, kindName), "SCOPE_INVALID");
    return call(["container", "exec", created.get("container"), "cat", paths[kindName]]);
  }
  async function root(operation, args = {}) {
    h.access(session, ["provision", "verify", "attest", "connect-check"]); h.check(owned && !uncertain, "RESOURCE_INVALID");
    if (["create-schema", "create-account", "grant"].includes(operation)) h.access(session, ["provision"]);
    const input = require("./nativeMysql.cjs").rootProgram(c, operation, args);
    return call(["container", "exec", "-i", "--env", "MYSQL_HISTFILE=/dev/null", created.get("container"), "mysql",
      "--defaults-file=/run/secrets/wmo-root-client", "--no-login-paths", "--protocol=SOCKET", "--batch", "--raw", "--skip-column-names", "--skip-reconnect", "--connect-timeout=5"], input + "\n");
  }
  async function remove() {
    h.access(session, ["teardown"]); h.check(owned && !uncertain, "QUARANTINED"); await inspect();
    for (const [type, id] of [["container", created.get("container")], ["network", created.get("network")], ["volume", created.get("volume")]]) {
      await observeHost();
      const current = singleton(await call([type, "inspect", id]));
      if (type === "volume") h.check(current.Name === id && current.Driver === "local" && current.Scope === "local" &&
        current.CreatedAt === volumeCreated && !Object.keys(current.Options || {}).length && e.same(current.Labels, { "wmo.test.purpose": e.PURPOSE, "wmo.test.run": c.runId }), "CLEANUP_INVALID");
      else if (type === "network") h.check(current.Id === id && current.Name === names.network && !Object.keys(current.Containers || {}).length &&
        e.same(current.Labels, { "wmo.test.purpose": e.PURPOSE, "wmo.test.run": c.runId }), "CLEANUP_INVALID");
      else h.check(current.Id === id && current.Name === "/" + names.container && e.same(current.Config.Labels,
        { ...imageLabels, "wmo.test.purpose": e.PURPOSE, "wmo.test.run": c.runId }), "CLEANUP_INVALID");
      await h.journal(session, "intent", type, id);
      try {
        if (type === "container") h.check(await call(["container", "stop", "--time", "10", id], "", 15000) === id, "CLEANUP_INVALID");
        h.check(await call([type, "rm", id]) === id, "CLEANUP_INVALID"); await absent(type, names[type]);
        await h.journal(session, "removed", type, id);
      } catch (caught) { uncertain = true; await h.journal(session, "uncertain", type, id).catch(() => {}); throw h.error(caught, "CLEANUP_INVALID"); }
    }
    for (const type of ["container", "network", "volume"]) await absent(type, names[type]);
    created.clear(); owned = null;
  }
  const adapter = Object.freeze({ observeHost, registry, create, start, inspect, readFile, root, remove,
    metrics: () => ({ commands: count, resources: created.size, uncertain }) });
  adapters.set(adapter, session); return adapter;
}
function assertDocker(session, adapter) { h.check(adapters.get(adapter) === session, "SCOPE_INVALID"); }
module.exports = { createDocker, readCommand, assertDocker };
