"use strict";

const { SafetyError } = require("./environment.cjs");
const nameOK = name => typeof name === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(name);
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const addAbortListener = AbortSignal.prototype.addEventListener;
const removeAbortListener = AbortSignal.prototype.removeEventListener;
function bounded(ms) {
  if (!Number.isInteger(ms) || ms < 1 || ms > 5000) throw new SafetyError("CONTROL_TIMEOUT_INVALID");
  return ms;
}
function createControls({ timeoutMs = 2000 } = {}) {
  bounded(timeoutMs);
  const barriers = new Map();
  let disposed = false;
  function waitOptions(options) {
    let properties;
    try {
      if (!options || typeof options !== "object" || Array.isArray(options) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Object.getOwnPropertySymbols(options).length) throw new Error();
      properties = Object.getOwnPropertyDescriptors(options);
      if (Object.keys(properties).some(k => !["timeoutMs", "signal"].includes(k)) ||
          Object.values(properties).some(p => !Object.hasOwn(p, "value"))) throw new Error();
    } catch (_) { throw new SafetyError("CONTROL_INVALID"); }
    const ms = bounded(properties.timeoutMs?.value ?? timeoutMs), signal = properties.signal?.value ?? undefined;
    let aborted = false;
    if (signal !== undefined) {
      try {
        if (!(signal instanceof AbortSignal)) throw new Error();
        aborted = signalAborted.call(signal);
      } catch (_) { throw new SafetyError("CONTROL_INVALID"); }
    }
    return { ms, signal, aborted };
  }
  function barrier(name) {
    if (disposed || !nameOK(name)) throw new SafetyError("CONTROL_INVALID");
    if (barriers.has(name)) return barriers.get(name);
    let state = "waiting", arrivals = 0, reason;
    const pending = new Set(), observers = new Set();
    const settle = (item, error) => {
      clearTimeout(item.timer); if (item.signal) removeAbortListener.call(item.signal, "abort", item.abort);
      pending.delete(item); observers.delete(item);
      if (error) item.reject(error); else item.resolve();
    };
    const cancel = (code = "BARRIER_CANCELLED") => {
      if (state !== "waiting") return false;
      state = "cancelled"; reason = new SafetyError(code);
      [...pending, ...observers].forEach(item => settle(item, reason)); return true;
    };
    function promise(set, { ms, signal }, count) {
      return new Promise((resolve, reject) => {
        const item = { resolve, reject, signal, count };
        item.abort = () => cancel();
        item.timer = setTimeout(() => cancel("BARRIER_TIMEOUT"), ms);
        set.add(item); if (signal) addAbortListener.call(signal, "abort", item.abort, { once: true });
      });
    }
    const api = Object.freeze({
      wait(options = {}) {
        const parsed = waitOptions(options);
        if (state === "cancelled") return Promise.reject(reason);
        if (state === "released") return Promise.resolve();
        // A signal already cancelled before admission must not count or cancel other participants.
        if (parsed.aborted) return Promise.reject(new SafetyError("BARRIER_CANCELLED"));
        const waiting = promise(pending, parsed);
        arrivals++;
        [...observers].filter(item => arrivals >= item.count).forEach(item => settle(item));
        return waiting;
      },
      reached(count = 1, options = {}) {
        if (!Number.isSafeInteger(count) || count < 1) throw new SafetyError("CONTROL_INVALID");
        const parsed = waitOptions(options);
        if (state === "cancelled") return Promise.reject(reason);
        if (arrivals >= count) return Promise.resolve();
        if (state === "released") return Promise.reject(new SafetyError("BARRIER_CLOSED"));
        if (parsed.aborted) return Promise.reject(new SafetyError("BARRIER_CANCELLED"));
        return promise(observers, parsed, count);
      },
      release() {
        if (state !== "waiting") return false;
        state = "released";
        [...pending].forEach(item => settle(item));
        [...observers].forEach(item => settle(item, arrivals >= item.count ? undefined : new SafetyError("BARRIER_CLOSED")));
        return true;
      },
      cancel: () => cancel(), fail: () => cancel("BARRIER_FAILED"),
      inspect: () => Object.freeze({ state, arrivals, pending: pending.size, observers: observers.size })
    });
    barriers.set(name, api); return api;
  }
  return Object.freeze({ barrier, dispose() { if (!disposed) { barriers.forEach(b => b.cancel()); disposed = true; } },
    inspect: () => Object.freeze({ disposed, barriers: barriers.size,
      pending: [...barriers.values()].reduce((sum, b) => sum + b.inspect().pending + b.inspect().observers, 0) }) });
}
async function withControls(operation, options) {
  const controls = createControls(options);
  try { return await operation(controls); } finally { controls.dispose(); }
}
const POINTS = Object.freeze(["acquire", "readiness", "timezone-read", "timezone-set", "begin", "business-write", "rollback", "commit", "timezone-restore", "release", "destroy"]);
function createFaultPoints(plan = []) {
  if (!Array.isArray(plan)) throw new SafetyError("FAULT_PLAN_INVALID");
  const rules = plan.map(p => {
    if (!p || Object.keys(p).some(k => !["point", "when", "times"].includes(k)) || !POINTS.includes(p.point) ||
        !["before", "after"].includes(p.when) || !Number.isInteger(p.times ?? 1) || (p.times ?? 1) < 1 || (p.times ?? 1) > 10) throw new SafetyError("FAULT_PLAN_INVALID");
    return { point: p.point, when: p.when, remaining: p.times ?? 1 };
  });
  return Object.freeze({ hit(point, when) {
    if (!POINTS.includes(point) || !["before", "after"].includes(when)) throw new SafetyError("FAULT_PLAN_INVALID");
    const rule = rules.find(p => p.point === point && p.when === when && p.remaining > 0);
    if (rule) { rule.remaining--; throw new SafetyError("ADAPTER_FAULT"); }
  }, remaining: () => rules.reduce((sum, r) => sum + r.remaining, 0) });
}
module.exports = { createControls, withControls, createFaultPoints };
