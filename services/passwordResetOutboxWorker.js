"use strict";

// Runs in the existing Render WEB PROCESS only when explicitly enabled.
// Durable MySQL leases allow multiple processes, although mail is at-least-once.
const { createPasswordResetOutboxService } = require("./passwordResetOutboxService");

function startPasswordResetOutboxWorker({ db, sendPasswordResetEmail, logger = console, intervalMs = 5000 }) {
  const service = createPasswordResetOutboxService({ db, sendPasswordResetEmail, logger });
  let running = false;
  let stopped = false;
  let timer = null;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try { await service.processOne(); }
    catch (error) { logger.error("[ResetOutbox] Worker cycle failed:", error?.code || error?.name || "UNKNOWN"); }
    finally { running = false; }
  }
  // Polling is explicitly enabled by configuration after review/deployment.
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); }, tick, service };
}

module.exports = { startPasswordResetOutboxWorker };
