const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
const source = fs.readFileSync(path.join(root, "frontend/js/landing.js"), "utf8");
const services = ["SWM Orientation & Clearance", "Accreditation", "IEC Resource Speaker", "Others"];

function requestForm({ storage } = {}) {
  const nodes = new Map();
  const requests = [];
  const timers = [];
  const modalEvents = [];
  const availabilityRequests = [];
  let activeElement = null, identifiers = 0;
  let availabilityHandler = null;
  // Derive ancestry and initial visibility from the real markup, then execute the real scripts.
  // This models hidden/inert focus boundaries; pixel layout still requires a browser.
  function element(tagName, attributes = new Map()) {
    const classes = new Set((attributes.get("class") || "").split(/\s+/));
    return {
      tagName, id: attributes.get("id") || "", value: attributes.get("value") || "", innerHTML: "", textContent: "",
      required: attributes.has("required"), disabled: attributes.has("disabled"), hidden: attributes.has("hidden"), inert: false,
      placeholder: attributes.get("placeholder") || "", listeners: {}, parentElement: null, scrollTop: 0,
      addEventListener(name, callback) { const old = this.listeners[name]; this.listeners[name] = old ? function (...args) { old.apply(this, args); return callback.apply(this, args); } : callback; },
      children: [], appendChild(child) { child.parentElement = this; this.children.push(child); },
      replaceChildren() { this.children.forEach(child => { child.parentElement = null; }); this.children = []; },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name) ?? null; }, removeAttribute(name) { attributes.delete(name); },
      focus(options) {
        for (let ancestor = this; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.hidden || ancestor.inert || ancestor.disabled) return;
        }
        activeElement = this; this.focusOptions = options;
        for (let ancestor = this; ancestor; ancestor = ancestor.parentElement) ancestor.listeners.focusin?.({ target: this });
      },
      click() {
        for (let ancestor = this; ancestor; ancestor = ancestor.parentElement) {
          if (ancestor.hidden || ancestor.inert || ancestor.disabled) return;
        }
        return this.listeners.click?.call(this, { target: this });
      },
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force = !classes.has(name)) { force ? classes.add(name) : classes.delete(name); }
      }
    };
  }
  const ancestors = [element("document")];
  const voidElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const markup = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  for (const [, closing, tagName, attributeText] of markup.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (closing) {
      const index = ancestors.findLastIndex(node => node.tagName === tagName);
      if (index > 0) ancestors.splice(index);
      continue;
    }
    const attributes = new Map([...attributeText.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/=]+)))?/g)]
      .map(([, name, double, single, unquoted]) => [name, double ?? single ?? unquoted ?? ""]));
    const node = element(tagName, attributes);
    ancestors.at(-1).appendChild(node);
    if (node.id) nodes.set(node.id, node);
    if (!voidElements.has(tagName) && !attributeText.endsWith("/")) ancestors.push(node);
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
    document: { getElementById: (id) => nodes.get(id) || null, addEventListener() {},
      get activeElement() { return activeElement; }, createElement: tagName => element(tagName) },
    window: { APP_CONFIG: { API_BASE_URL: "http://127.0.0.1/api" }, bootstrap },
    bootstrap, console,
    setTimeout(callback) { timers.push(callback); }, clearTimeout() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, text: async () => JSON.stringify({ success: true, appointment_code: "APT-900001" }) };
    }
  };
  context.window.fetch = async (url, options) => {
    if (url.includes("/availability?")) {
      availabilityRequests.push({ url, options });
      if (availabilityHandler) return availabilityHandler(url, options);
      const query = new URL(url).searchParams;
      return { ok: true, json: async () => ({ success: true, service: query.get("service"), date: query.get("date"),
        slots: ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"].map(time => ({ time, status: "available" })) }) };
    }
    return context.fetch(url, options);
  };
  context.window.crypto = { randomUUID() { identifiers++; return require("node:crypto").randomUUID(); } };
  context.window.sessionStorage = storage;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "frontend/js/appointment-slots.js"), "utf8"), context);
  vm.runInContext(source, context);
  context.setupAppointmentForm();
  return {
    nodes, requests, timers, modalEvents, context, availabilityRequests,
    get identifiers() { return identifiers; },
    setAvailability(handler) { availabilityHandler = handler; },
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
      return select.listeners.change.call(select);
    },
    async prepareSlots() {
      await nodes.get("preferredDate").listeners.change();
      const button = nodes.get("customTimeMenu").children[0];
      button.click();
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
    assert.equal(page.nodes.get("appointmentMessage").textContent, message);
    assert.equal(page.nodes.get("submitAppointmentBtn").disabled, false);
    assert.equal(page.requests.length, 0);
    assert.equal(page.timers.length, 0);
  }
});

test("all services still submit the exact purpose payload key and original values through a mocked POST", async () => {
  for (const purpose of services) {
    const page = requestForm();
    page.fill({ purpose });
    await page.prepareSlots();
    await page.submit();
    assert.equal(page.requests.length, 0, "review must precede final submission");
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
  assert.equal(page.nodes.get("submitAppointmentBtn").textContent, "Review Request");
  assert.equal(page.requests.length, 0);
});


test("slot conflict preserves citizen fields, clears stale selection and refreshes availability", async () => {
  const page = requestForm(); page.fill(); await page.prepareSlots(); await page.submit();
  page.context.fetch = async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ success: false,
    code: "SLOT_UNAVAILABLE", message: "This time slot is no longer available." }) });
  await page.submit();
  assert.equal(page.nodes.get("fullName").value, " Test Citizen ");
  assert.equal(page.nodes.get("appointmentTime").value, "");
  assert.equal(page.nodes.get("appointmentReview").hidden, true);
  assert.equal(page.nodes.get("appointmentEditView").hidden, false);
  assert.equal(page.nodes.get("appointmentEditView").inert, false);
  assert.equal(page.nodes.get("editAppointmentReview").hidden, true);
  assert.equal(page.nodes.get("submitAppointmentBtn").textContent, "Review Request");
  assert.equal(page.nodes.get("contactNumber").value, "09123456789");
  assert.equal(page.nodes.get("emailAddress").value, "citizen@example.com");
  assert.equal(page.nodes.get("notes").value, " Additional details ");
  assert.match(page.nodes.get("appointmentMessage").textContent, /no longer available/);
  await page.submit();
  assert.equal(page.nodes.get("appointmentReview").hidden, true, "a new time selection is required after conflict");
});

test("review replaces the entire edit layout, traps focus outside it and resets only the modal scroll", async () => {
  const page = requestForm(); page.fill(); await page.prepareSlots();
  const edit = page.nodes.get("appointmentEditView"), review = page.nodes.get("appointmentReview");
  const body = page.nodes.get("appointmentModalBody"), title = page.nodes.get("appointmentReviewTitle");
  const contact = page.nodes.get("emailAddress");
  contact.focus(); body.scrollTop = 260;
  await page.submit();
  assert.equal(edit.hidden, true); assert.equal(edit.inert, true); assert.equal(review.hidden, false);
  for (const id of ["purpose", "preferredDate", "customTimeMenu", "fullName", "notes"]) {
    let ancestor = page.nodes.get(id);
    while (ancestor && ancestor !== edit) ancestor = ancestor.parentElement;
    assert.equal(ancestor, edit, `${id} must be inside the mutually exclusive edit view`);
    page.nodes.get(id).focus();
    assert.equal(page.context.document.activeElement, title, `${id} must not receive focus during review`);
  }
  let ancestor = review.parentElement;
  while (ancestor && ancestor !== edit) ancestor = ancestor.parentElement;
  assert.equal(ancestor, null, "review must be a sibling view, not part of the hidden edit layout");
  assert.equal(body.scrollTop, 0);
  assert.equal(title.focusOptions.preventScroll, true);
  assert.equal(page.nodes.get("appointmentStepReview").getAttribute("aria-current"), "step");
  assert.equal(page.nodes.get("appointmentStepTime").getAttribute("aria-current"), null);
  assert.equal(page.nodes.get("cancelAppointmentRequest").hidden, true);
  assert.equal(page.nodes.get("editAppointmentReview").hidden, false);
  assert.equal(page.nodes.get("submitAppointmentBtn").textContent, "Confirm Request");
  assert.equal(page.requests.length, 0); assert.equal(page.identifiers, 0);
  page.nodes.get("editAppointmentReview").click();
  assert.equal(edit.hidden, false); assert.equal(edit.inert, false); assert.equal(review.hidden, true);
  assert.equal(page.context.document.activeElement, contact);
  assert.equal(body.scrollTop, 260);
  assert.equal(page.nodes.get("cancelAppointmentRequest").hidden, false);
  assert.equal(page.nodes.get("appointmentStepTime").getAttribute("aria-current"), "step");
});

test("review cards show current values, Philippine calendar date and safe meaningful notes", async () => {
  const page = requestForm();
  const longName = "Synthetic " + "Long Name ".repeat(25), notes = "Line one\n<img src=x onerror=alert(1)>";
  page.fill({ fullName: longName, notes }); await page.prepareSlots(); await page.submit();
  const expected = { Service: services[0], Date: "October 5, 2099", Time: "9:00 AM", Name: longName.trim(),
    Barangay: "Apopong", Contact: "09123456789", Email: "citizen@example.com", Notes: notes };
  for (const [field, value] of Object.entries(expected)) {
    const node = page.nodes.get(`appointmentReview${field}`);
    assert.equal(node.textContent, value); assert.equal(node.innerHTML, "");
  }
  assert.equal(page.nodes.get("appointmentReviewNotesSection").hidden, false);
  assert.match(page.nodes.get("appointmentReviewNotice").textContent, /pending WMO approval/);
  assert.equal(page.requests.length, 0);
});

test("back-to-edit preserves all fields and the selected slot; a second review uses updated values", async () => {
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const page = requestForm({ storage }); page.fill({ notes: "   " }); await page.prepareSlots(); await page.submit();
  assert.equal(page.nodes.get("appointmentReviewNotesSection").hidden, true);
  const ids = ["purpose", "preferredDate", "appointmentTime", "fullName", "barangay", "contactNumber", "emailAddress", "notes"];
  const original = ids.map(id => page.nodes.get(id).value), calls = page.availabilityRequests.length;
  page.nodes.get("editAppointmentReview").click();
  assert.deepEqual(ids.map(id => page.nodes.get(id).value), original);
  assert.equal(page.availabilityRequests.length, calls, "Back to Edit must not fetch");
  page.nodes.get("fullName").value = "Updated Synthetic Citizen";
  page.nodes.get("fullName").listeners.input();
  page.nodes.get("emailAddress").value = "updated@example.invalid";
  page.nodes.get("notes").value = "Updated notes";
  await page.submit();
  assert.equal(page.nodes.get("appointmentReviewName").textContent, "Updated Synthetic Citizen");
  assert.equal(page.nodes.get("appointmentReviewEmail").textContent, "updated@example.invalid");
  assert.equal(page.nodes.get("appointmentReviewNotes").textContent, "Updated notes");
  assert.equal(page.nodes.get("appointmentReviewNotesSection").hidden, false);
  assert.equal(page.nodes.get("appointmentTime").value, "09:00");
  assert.equal(page.availabilityRequests.length, calls + 1, "review revalidates once");
  assert.equal(saved.size, 0); assert.equal(page.identifiers, 0); assert.equal(page.requests.length, 0);
});

function availabilityReply(url, status = "available") {
  const query = new URL(url).searchParams;
  return { ok: true, json: async () => ({ success: true, service: query.get("service"), date: query.get("date"),
    slots: ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"].map(time => ({ time, status })) }) };
}

test("review rechecks the selected slot and blocks a newly occupied or unavailable snapshot", async () => {
  for (const condition of ["occupied", "offline"]) {
    const page = requestForm(); page.fill(); await page.prepareSlots();
    page.setAvailability(async url => {
      if (condition === "offline") throw Error("Availability temporarily offline");
      return availabilityReply(url, "occupied");
    });
    await page.submit();
    assert.equal(page.nodes.get("appointmentReview").hidden, true);
    assert.equal(page.nodes.get("appointmentEditView").hidden, false);
    assert.equal(page.nodes.get("appointmentTime").value, "");
    assert.equal(page.nodes.get("fullName").value, " Test Citizen ");
    assert.equal(page.requests.length, 0); assert.equal(page.identifiers, 0);
    assert.match(page.nodes.get("appointmentMessage").textContent, /choose an available time/);
  }
});

test("double review clicks perform one availability recheck and never submit or allocate a key", async () => {
  const page = requestForm(); page.fill(); await page.prepareSlots();
  let reply;
  page.setAvailability(url => new Promise(resolve => { reply = () => resolve(availabilityReply(url)); }));
  const before = page.availabilityRequests.length, first = page.submit();
  await page.submit();
  assert.equal(page.availabilityRequests.length, before + 1);
  assert.equal(page.nodes.get("submitAppointmentBtn").disabled, true);
  assert.equal(page.nodes.get("retryAppointmentAvailability").disabled, true);
  reply(); await first;
  assert.equal(page.nodes.get("appointmentReview").hidden, false);
  assert.equal(page.nodes.get("submitAppointmentBtn").disabled, false);
  assert.equal(page.requests.length, 0); assert.equal(page.identifiers, 0);
});

test("details changed during a review recheck cannot produce a stale review confirmation", async () => {
  const page = requestForm(); page.fill(); await page.prepareSlots();
  let reply;
  page.setAvailability(url => new Promise(resolve => { reply = () => resolve(availabilityReply(url)); }));
  const checking = page.submit();
  page.nodes.get("fullName").value = "Changed while checking";
  page.nodes.get("fullName").listeners.input();
  reply(); await checking;
  assert.equal(page.nodes.get("appointmentReview").hidden, true);
  assert.equal(page.nodes.get("fullName").value, "Changed while checking");
  assert.match(page.nodes.get("appointmentMessage").textContent, /details changed/);
  assert.equal(page.requests.length, 0);
});

test("refresh is grouped with the time heading, disabled without a schedule and deduplicates manual loading clicks", async () => {
  const page = requestForm(), refresh = page.nodes.get("retryAppointmentAvailability");
  assert.equal(refresh.parentElement, page.nodes.get("appointmentTimeLabel").parentElement);
  assert.equal(refresh.getAttribute("aria-label"), "Refresh available appointment times");
  assert.equal(refresh.disabled, true); assert.equal(refresh.getAttribute("aria-busy"), "false");
  assert.equal(page.availabilityRequests.length, 0);
  page.fill(); await page.prepareSlots();
  assert.equal(refresh.disabled, false);
  let reply;
  page.setAvailability(url => new Promise(resolve => { reply = () => resolve(availabilityReply(url)); }));
  const before = page.availabilityRequests.length, checking = refresh.click();
  assert.equal(refresh.disabled, true); assert.equal(refresh.getAttribute("aria-busy"), "true");
  refresh.click(); refresh.listeners.click();
  assert.equal(page.availabilityRequests.length, before + 1);
  reply(); await checking;
  assert.equal(refresh.disabled, false); assert.equal(refresh.getAttribute("aria-busy"), "false");
  assert.equal(page.nodes.get("appointmentTime").value, "", "manual refresh still requires selecting a time");
  assert.match(page.nodes.get("appointmentAvailabilityStatus").textContent, /Philippine time/);
  assert.equal(page.nodes.get("appointmentAvailabilityStatus").getAttribute("aria-live"), "polite");
});

test("service and date changes refresh the existing picker and invalidate the review", async () => {
  const page = requestForm(); page.fill(); await page.prepareSlots(); await page.submit();
  let before = page.availabilityRequests.length;
  await page.selectService("Accreditation");
  assert.equal(page.availabilityRequests.length, before + 1);
  assert.equal(new URL(page.availabilityRequests.at(-1).url).searchParams.get("service"), "Accreditation");
  assert.equal(page.nodes.get("appointmentReview").hidden, true);
  assert.equal(page.nodes.get("appointmentTime").value, "");
  before = page.availabilityRequests.length;
  page.nodes.get("preferredDate").value = "2099-10-06";
  await page.nodes.get("preferredDate").listeners.change();
  assert.equal(page.availabilityRequests.length, before + 1);
  assert.equal(new URL(page.availabilityRequests.at(-1).url).searchParams.get("date"), "2099-10-06");
  assert.equal(page.nodes.get("fullName").value, " Test Citizen ");
  page.nodes.get("purpose").value = "";
  await page.nodes.get("purpose").listeners.change.call(page.nodes.get("purpose"));
  assert.equal(page.nodes.get("retryAppointmentAvailability").disabled, true);
  assert.equal(page.requests.length, 0);
});

test("back and review after an uncertain submission preserve its key and recovery-only behavior", async () => {
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const page = requestForm({ storage }); page.fill(); await page.prepareSlots(); await page.submit();
  const posts = [];
  page.context.fetch = async (url, options) => {
    posts.push(options);
    return posts.length === 1 ? { ok: false, status: 503, text: async () => JSON.stringify({ success: false }) }
      : { ok: true, text: async () => JSON.stringify({ success: true, appointment_code: "APT-900001" }) };
  };
  await page.submit();
  const originalKey = posts[0].headers["Idempotency-Key"], availabilityCalls = page.availabilityRequests.length;
  page.nodes.get("editAppointmentReview").click(); await page.submit();
  assert.equal(page.nodes.get("submitAppointmentBtn").textContent, "Recover Reference");
  assert.equal(page.nodes.get("retryAppointmentAvailability").disabled, true);
  assert.equal(page.identifiers, 1); assert.deepEqual([...saved.values()], [originalKey]);
  assert.equal(page.availabilityRequests.length, availabilityCalls, "recovery must bypass slot availability");
  await page.submit();
  assert.equal(posts.length, 2); assert.equal(posts[1].headers["Idempotency-Key"], originalKey);
  assert.equal(posts[1].headers["Idempotency-Recovery"], "true");
  assert.equal(page.identifiers, 1); assert.equal(saved.size, 0);
});

test("unknown availability and occupied slots cannot be selected or submitted", async () => {
  const page = requestForm(); page.fill();
  page.setAvailability(async () => { throw new Error("Synthetic offline"); });
  await page.nodes.get("preferredDate").listeners.change();
  assert.ok(page.nodes.get("customTimeMenu").children.every(button => button.disabled));
  await page.submit(); assert.equal(page.requests.length, 0);
  assert.match(page.nodes.get("appointmentAvailabilityStatus").textContent, /offline/);
  page.setAvailability(async url => { const params = new URL(url).searchParams;
    return { ok: true, json: async () => ({ success: true, service: params.get("service"), date: params.get("date"),
      slots: ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"].map(time => ({ time, status: "occupied" })) }) };
  });
  await page.nodes.get("preferredDate").listeners.change();
  assert.ok(page.nodes.get("customTimeMenu").children.every(button => button.disabled));
  assert.match(page.nodes.get("customTimeMenu").children[0].textContent, /Fully Booked/);
});

test("late availability responses cannot replace a newer service selection", async () => {
  const page = requestForm(); page.fill(); const pending = [];
  page.setAvailability(url => new Promise(resolve => pending.push({ url, resolve })));
  const first = page.nodes.get("preferredDate").listeners.change();
  page.nodes.get("purpose").value = "IEC Resource Speaker";
  const second = page.nodes.get("preferredDate").listeners.change();
  const reply = item => { const query = new URL(item.url).searchParams;
    item.resolve({ ok: true, json: async () => ({ success: true, service: query.get("service"), date: query.get("date"),
      slots: ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"].map(time => ({ time, status: query.get("service") === "Accreditation" ? "occupied" : "available" })) }) }); };
  reply(pending[1]); await second; reply(pending[0]); await first;
  assert.ok(page.nodes.get("customTimeMenu").children.every(button => !button.disabled));
});

test("double-click cannot duplicate an in-flight submission and uncertain retry reuses its key", async () => {
  const page = requestForm(); page.fill(); await page.prepareSlots(); await page.submit();
  const calls = []; let respond;
  page.context.fetch = (url, options) => { calls.push(options); return new Promise(resolve => { respond = resolve; }); };
  const first = page.submit(); await page.submit(); assert.equal(calls.length, 1);
  respond({ ok: false, status: 503, text: async () => JSON.stringify({ success: false, message: "Uncertain result" }) }); await first;
  const second = page.submit(); assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  respond({ ok: true, text: async () => JSON.stringify({ success: true, appointment_code: "APT-900001" }) }); await second;
});

test("submission timeout retains recovery key and blocks changed details until the outcome is recovered", async () => {
  const page = requestForm(); page.fill(); await page.prepareSlots(); await page.submit();
  page.context.window.AbortController = AbortController;
  page.context.console = { error() {} };
  const calls = [];
  page.context.fetch = (url, options) => {
    calls.push(options);
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Synthetic timeout")), { once: true }));
  };
  const pending = page.submit();
  page.timers.shift()(); await pending;
  assert.match(page.nodes.get("appointmentMessage").textContent, /could not be confirmed/);
  page.nodes.get("fullName").value = "Different details";
  await page.submit(); assert.equal(calls.length, 1);
  assert.match(page.nodes.get("appointmentMessage").textContent, /previous submission outcome is uncertain/);
  page.nodes.get("fullName").value = " Test Citizen ";
  page.context.fetch = async (url, options) => { calls.push(options); return { ok: true,
    text: async () => JSON.stringify({ success: true, appointment_code: "APT-900001" }) }; };
  await page.submit();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
});

test("reload recovery persists only the opaque request key and clears it after reference acknowledgement", async () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const first = requestForm({ storage }); first.fill(); await first.prepareSlots(); await first.submit();
  let originalKey;
  first.context.fetch = async (url, options) => {
    originalKey = options.headers["Idempotency-Key"];
    return { ok: false, status: 503, text: async () => JSON.stringify({ success: false }) };
  };
  await first.submit();
  assert.deepEqual([...saved.values()], [originalKey]);
  assert.doesNotMatch(JSON.stringify([...saved]), /Citizen|example.com|09123456789/);
  const second = requestForm({ storage }); second.fill(); await second.prepareSlots(); await second.submit(); await second.submit();
  assert.equal(second.requests[0].options.headers["Idempotency-Key"], originalKey);
  assert.equal(saved.size, 0);
});

test("lost committed response reloads and recovers through real scheduling code despite occupied, elapsed or unavailable slots", async () => {
  const { fixture } = require("./helpers/appointmentSchedulingFixture");
  for (const condition of ["occupied", "elapsed", "availability-failure", "changed-payload"]) {
    const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
    const f = fixture({ commitUncertain: true });
    const originalValues = { preferredDate: "2026-11-23" };
    const first = requestForm({ storage }); first.fill(originalValues); await first.prepareSlots(); await first.submit();
    first.context.console = { error() {} };
    first.context.fetch = async (_url, options) => {
      await f.service.book(JSON.parse(options.body), options.headers["Idempotency-Key"]);
      throw new Error("Expected lost commit acknowledgement");
    };
    await first.submit();
    assert.equal(f.state.appointments.length, 1);
    const key = [...saved.values()][0], code = f.state.appointments[0].appointment_code;
    if (condition === "elapsed") f.service.now = () => new Date("2026-11-24T00:00:00Z");
    const second = requestForm({ storage }); second.fill(originalValues);
    let availabilityCalls = 0;
    second.setAvailability(async url => {
      availabilityCalls++;
      if (condition === "availability-failure") throw new Error("Synthetic unavailable availability");
      const q = new URL(url).searchParams;
      return { ok: true, json: () => f.service.availability(q.get("service"), q.get("date")) };
    });
    const submissions = [];
    second.context.fetch = async (_url, options) => {
      submissions.push(options);
      try {
        const result = await f.service.book(JSON.parse(options.body), options.headers["Idempotency-Key"],
          { recoveryOnly: options.headers["Idempotency-Recovery"] === "true" });
        return { ok: true, text: async () => JSON.stringify(result) };
      } catch (error) { return { ok: false, status: error.statusCode, text: async () => JSON.stringify({ success: false, code: error.code, message: error.message }) }; }
    };
    await second.nodes.get("preferredDate").listeners.change();
    assert.equal(second.nodes.get("preferredDate").min, "", "native date minimum must permit recovery of elapsed requests");
    assert.equal(second.nodes.get("customTimeMenu").children[0].disabled, false, condition);
    second.nodes.get("customTimeMenu").children[0].click();
    if (condition === "changed-payload") second.nodes.get("fullName").value = "Different Citizen";
    await second.submit(); await second.submit();
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].headers["Idempotency-Key"], key);
    assert.equal(submissions[0].headers["Idempotency-Recovery"], "true");
    assert.equal(availabilityCalls, 0, "recovery must not depend on availability");
    assert.equal(f.state.appointments.length, 1);
    assert.equal(f.state.notifications.length, 1);
    assert.equal(f.state.slots.length, 1);
    if (condition === "changed-payload") {
      assert.equal(saved.size, 1);
      assert.match(second.nodes.get("appointmentMessage").textContent, /different booking details/);
      assert.equal(second.modalEvents.length, 0);
    } else {
      assert.equal(saved.size, 0);
      second.timers.at(-1)();
      assert.equal(second.nodes.get("successAppointmentCode").textContent, code);
    }
  }
});
