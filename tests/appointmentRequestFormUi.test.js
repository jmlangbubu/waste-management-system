const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "frontend/js/landing.js"), "utf8");
const services = ["SWM Orientation & Clearance", "Accreditation", "IEC Resource Speaker", "Others"];

function requestForm() {
  const nodes = new Map();
  const requests = [];
  const timers = [];
  const modalEvents = [];
  for (const id of [
    "appointmentForm", "appointmentMessage", "fullName", "barangay", "contactNumber",
    "emailAddress", "purpose", "preferredDate", "appointmentTime", "notes",
    "appointmentModal", "submitAppointmentBtn", "customTimeDropdown", "customTimeSelected",
    "customTimeMenu", "appointmentSuccessModal", "successAppointmentCode"
  ]) {
    const classes = new Set();
    nodes.set(id, {
      id, value: "", innerHTML: "", textContent: "", required: false, disabled: false,
      placeholder: "", listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); }
      }
    });
  }
  nodes.get("notes").placeholder = "Enter additional details";
  nodes.get("appointmentForm").reset = () => {
    for (const id of ["fullName", "barangay", "contactNumber", "emailAddress", "purpose", "preferredDate", "appointmentTime", "notes"]) {
      nodes.get(id).value = "";
    }
  };
  nodes.get("customTimeMenu").querySelectorAll = () => [];
  const bootstrap = {
    Modal: {
      getOrCreateInstance: (element) => ({
        show() { modalEvents.push({ id: element.id, action: "show" }); },
        hide() { modalEvents.push({ id: element.id, action: "hide" }); }
      })
    }
  };
  const context = {
    document: { getElementById: (id) => nodes.get(id) || null, addEventListener() {} },
    window: { APP_CONFIG: { API_BASE_URL: "http://127.0.0.1/api" }, bootstrap },
    bootstrap, console,
    setTimeout(callback) { timers.push(callback); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, text: async () => JSON.stringify({ success: true, appointment_code: "APT-900001" }) };
    }
  };
  vm.runInNewContext(source, context);
  context.setupAppointmentForm();
  return {
    nodes, requests, timers, modalEvents,
    fill(overrides = {}) {
      const values = {
        fullName: " Test Citizen ", barangay: "Apopong", contactNumber: "09123456789",
        emailAddress: "citizen@example.com", purpose: services[0], preferredDate: "2099-10-05",
        appointmentTime: "09:00", notes: " Additional details ", ...overrides
      };
      Object.entries(values).forEach(([id, value]) => { nodes.get(id).value = value; });
    },
    selectService(value) {
      const select = nodes.get("purpose");
      select.value = value;
      select.listeners.change.call(select);
    },
    submit: () => nodes.get("appointmentForm").listeners.submit({ preventDefault() {} })
  };
}

test("request modal shows Service wording while preserving the purpose field and option values", () => {
  const form = html.match(/<form id="appointmentForm">([\s\S]*?)<\/form>/)?.[1];
  assert.ok(form);
  assert.match(form, /<label for="purpose" class="form-label">Service<\/label>/);
  const select = form.match(/<select id="purpose" class="form-select" required>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select);
  assert.match(select, /<option value="">Select service<\/option>/);
  assert.deepEqual([...select.matchAll(/<option value="([^"]*)">/g)].map((match) => match[1]), ["", ...services]);
  assert.doesNotMatch(form, />Purpose<|Select purpose|id="service"/);
});

test("Others requires notes and uses service helper wording; selecting another service clears that requirement", () => {
  const page = requestForm();
  for (const value of [services[0], "Others", services[1], "Others", services[2], ""]) {
    page.selectService(value);
    const notes = page.nodes.get("notes");
    assert.equal(notes.required, value === "Others");
    assert.equal(notes.placeholder, value === "Others" ? "Please specify your service" : "Enter additional details");
  }
  assert.equal(page.requests.length, 0);
});

test("invalid form submissions show existing validation messages without fetching", async () => {
  const cases = [
    [{ purpose: "" }, "Please fill in all required fields."],
    [{ contactNumber: "123" }, "Contact number must be exactly 11 digits."],
    [{ emailAddress: "not-an-email" }, "Please enter a valid email address."],
    [{ purpose: "Others", notes: "  " }, "Please specify your service in Additional Notes."]
  ];
  for (const [values, message] of cases) {
    const page = requestForm();
    page.fill(values);
    await page.submit();
    assert.equal(page.nodes.get("appointmentMessage").innerHTML, message);
    assert.equal(page.nodes.get("submitAppointmentBtn").disabled, false);
    assert.equal(page.requests.length, 0);
    assert.equal(page.timers.length, 0);
  }
});

test("all services still submit the exact purpose payload key and original values through a mocked POST", async () => {
  for (const purpose of services) {
    const page = requestForm();
    page.fill({ purpose });
    await page.submit();
    assert.equal(page.requests.length, 1);
    const { url, options } = page.requests[0];
    assert.equal(url, "http://127.0.0.1/api/appointments");
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), {
      full_name: "Test Citizen", barangay: "Apopong", contact_number: "09123456789",
      email: "citizen@example.com", purpose, preferred_date: "2099-10-05 09:00:00",
      notes: "Additional details"
    });
    assert.equal(Object.hasOwn(JSON.parse(options.body), "service"), false);
    assert.equal(page.timers.length, 1);
    page.timers.shift()();
    assert.equal(page.nodes.get("successAppointmentCode").textContent, "APT-900001");
    assert.deepEqual(page.modalEvents, [
      { id: "appointmentModal", action: "hide" }, { id: "appointmentSuccessModal", action: "show" }
    ]);
  }
});

test("closing the request modal resets Others notes requirements and the existing time selection", () => {
  const page = requestForm();
  page.fill();
  page.selectService("Others");
  page.nodes.get("customTimeDropdown").classList.add("open");
  page.nodes.get("appointmentModal").listeners["hidden.bs.modal"]();
  assert.equal(page.nodes.get("purpose").value, "");
  assert.equal(page.nodes.get("notes").required, false);
  assert.equal(page.nodes.get("notes").placeholder, "Enter additional details");
  assert.equal(page.nodes.get("appointmentTime").value, "");
  assert.equal(page.nodes.get("customTimeDropdown").classList.contains("open"), false);
  assert.equal(page.nodes.get("submitAppointmentBtn").textContent, "Submit Request");
  assert.equal(page.requests.length, 0);
});
