const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/js/landing.js"), "utf8");

function landing(search, { reference = "", contact = "", missingReference = false } = {}) {
  const nodes = new Map();
  const requests = [];
  let ready;
  let scrollCount = 0;
  let modalCount = 0;
  for (const id of [
    "statusAppointmentCode", "statusContact", "appointmentStatusSection",
    "checkAppointmentStatusForm", "appointmentStatusResult", "checkAppointmentStatusBtn",
    "appointmentStatusModal", "appointmentStatusModalBody"
  ]) {
    nodes.set(id, {
      value: "", textContent: "", innerHTML: "", disabled: false, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      scrollIntoView() { scrollCount += 1; }
    });
  }
  nodes.get("statusAppointmentCode").value = reference;
  nodes.get("statusContact").value = contact;
  if (missingReference) nodes.delete("statusAppointmentCode");
  const bootstrap = {
    Modal: { getOrCreateInstance: () => ({ show() { modalCount += 1; } }) }
  };
  const context = {
    document: {
      getElementById: (id) => nodes.get(id) || null,
      querySelectorAll: () => [],
      addEventListener(name, callback) { if (name === "DOMContentLoaded") ready = callback; }
    },
    window: { location: { search }, APP_CONFIG: { API_BASE_URL: "https://wastegensan.com/api" }, bootstrap },
    bootstrap, URLSearchParams, console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          appointment: { appointment_code: "APT-900001", status: "approved" }
        })
      };
    }
  };
  vm.runInNewContext(source, context);
  ready();
  return {
    nodes, requests,
    get scrollCount() { return scrollCount; },
    get modalCount() { return modalCount; },
    submit: () => nodes.get("checkAppointmentStatusForm").listeners.submit({ preventDefault() {} })
  };
}

test("email link prefills only the reference and does not request or reveal status", () => {
  const page = landing("?appointment_code=APT-900001&contact=someone%40example.com&email=other%40example.com");
  assert.equal(page.nodes.get("statusAppointmentCode").value, "APT-900001");
  assert.equal(page.nodes.get("statusContact").value, "");
  assert.equal(page.scrollCount, 1);
  assert.equal(page.requests.length, 0);
  assert.equal(page.modalCount, 0);
  assert.equal(page.nodes.get("appointmentStatusModalBody").innerHTML, "");
  assert.equal(page.nodes.get("checkAppointmentStatusBtn").disabled, false);
});

test("absent, malformed, and oversized references leave the tracker untouched", () => {
  for (const search of [
    "", "?contact=09123456789", "?reference=APT-900001", "?appointment_code=",
    "?appointment_code=APT-12345", "?appointment_code=APT-123456789012345678901",
    "?appointment_code=apt-900001", "?appointment_code=APT-900001extra",
    "?appointment_code=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
    "?appointment_code=APT-900001%0AAPT-900002"
  ]) {
    const page = landing(search);
    assert.equal(page.nodes.get("statusAppointmentCode").value, "", search);
    assert.equal(page.nodes.get("statusContact").value, "", search);
    assert.equal(page.scrollCount, 0, search);
    assert.equal(page.requests.length, 0, search);
    assert.equal(page.modalCount, 0, search);
  }
});

test("valid reference boundaries and URL-encoded surrounding whitespace are accepted", () => {
  for (const reference of ["APT-123456", "APT-12345678901234567890"]) {
    const page = landing(`?appointment_code=${encodeURIComponent(` ${reference} `)}`);
    assert.equal(page.nodes.get("statusAppointmentCode").value, reference);
    assert.equal(page.requests.length, 0);
    assert.equal(page.scrollCount, 1);
  }
});

test("prefill preserves an existing reference and manually entered verification", () => {
  const page = landing("?appointment_code=APT-900001&contact=url%40example.com", {
    reference: "APT-700002", contact: "manual@example.com"
  });
  assert.equal(page.nodes.get("statusAppointmentCode").value, "APT-700002");
  assert.equal(page.nodes.get("statusContact").value, "manual@example.com");
  assert.equal(page.scrollCount, 0);
  assert.equal(page.requests.length, 0);
});

test("pages without the reference input remain safe", () => {
  const page = landing("?appointment_code=APT-900001", { missingReference: true });
  assert.equal(page.requests.length, 0);
  assert.equal(page.scrollCount, 0);
  assert.equal(page.modalCount, 0);
});

test("the existing manual submit still requires email/contact verification", async () => {
  const page = landing("?appointment_code=APT-900001&contact=query%40example.com");
  await page.submit();
  assert.equal(page.requests.length, 0);
  assert.equal(page.modalCount, 0);
  assert.match(page.nodes.get("appointmentStatusResult").innerHTML,
    /Please enter your reference code and email\/contact number/);

  page.nodes.get("statusContact").value = "citizen@example.com";
  await page.submit();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, "https://wastegensan.com/api/appointments/check-status");
  assert.equal(page.requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(page.requests[0].options.body), {
    appointment_code: "APT-900001", contact: "citizen@example.com"
  });
  assert.equal(page.modalCount, 1);
});
