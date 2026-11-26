/* =========================================================
   WMO LANDING PAGE JAVASCRIPT
   Main Project Merge
   - Preserves config.js API flow
   - Preserves appointment request flow
   - Preserves appointment status checker
   - Adds feature card interaction
   - Adds scroll reveal animation
========================================================= */

/* =========================
   API HELPERS
========================= */

function getAppApiBase() {
  const configuredBase =
    window.APP_CONFIG?.API_BASE_URL ||
    window.API_BASE ||
    "";

  if (!configuredBase) {
    console.error("API BASE URL is not defined. Check config.js / APP_CONFIG.");
    return "";
  }

  return String(configuredBase).replace(/\/$/, "");
}

function getAppointmentsCreateApiUrl() {
  const base = getAppApiBase();
  return base ? `${base}/appointments` : "";
}

function getAppointmentCheckStatusApiUrl() {
  const base = getAppApiBase();
  return base ? `${base}/appointments/check-status` : "";
}

/* =========================
   MAIN INIT
========================= */

document.addEventListener("DOMContentLoaded", () => {
  setupFeatureShowcase();
  setupAppointmentForm();
  setupAppointmentStatusChecker();
  prefillAppointmentStatusReference();
  setupScrollRevealAnimations();
});

function prefillAppointmentStatusReference() {
  const referenceInput = document.getElementById("statusAppointmentCode");
  if (!referenceInput || referenceInput.value.trim()) return;

  const reference = new URLSearchParams(window.location.search)
    .get("appointment_code")?.trim() || "";
  if (!/^APT-\d{6,20}$/.test(reference)) return;

  referenceInput.value = reference;
  document.getElementById("appointmentStatusSection")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

/* =========================================================
   INTERACTIVE PHONE FEATURE SHOWCASE
========================================================= */

function setupFeatureShowcase() {
  const featureButtons = document.querySelectorAll(".floating-feature-card");
  const featureInfoIcon = document.getElementById("featureInfoIcon");
  const featureInfoTitle = document.getElementById("featureInfoTitle");
  const featureInfoDescription = document.getElementById("featureInfoDescription");
  const infoCard = document.getElementById("featureInfoCard");

  if (!featureButtons.length || !featureInfoIcon || !featureInfoTitle || !featureInfoDescription) {
    return;
  }

  const featureContent = {
    complaint: {
      icon: "📍",
      title: "Complaint Reporting",
      description:
        "Report waste-related concerns with location details and evidence, then track updates until resolution."
    },
    certificate: {
      icon: "📄",
      title: "Digital Certificate",
      description:
        "Access digital certificates and service records after completing required processes and validation."
    },
    scan: {
      icon: "📷",
      title: "Waste Scan",
      description:
        "Scan waste items and receive classification guidance for proper segregation and disposal."
    }
  };

  function setActiveFeature(featureKey) {
    const selectedFeature = featureContent[featureKey] || featureContent.complaint;

    featureButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.feature === featureKey);
    });

    featureInfoIcon.textContent = selectedFeature.icon;
    featureInfoTitle.textContent = selectedFeature.title;
    featureInfoDescription.textContent = selectedFeature.description;

    if (infoCard) {
      infoCard.classList.remove("feature-card-pop");
      void infoCard.offsetWidth;
      infoCard.classList.add("feature-card-pop");
    }
  }

  featureButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActiveFeature(button.dataset.feature || "complaint");
    });
  });

  setActiveFeature("complaint");
}

/* =========================================================
   APPOINTMENT REQUEST FORM
========================================================= */

function setupAppointmentForm() {
  const appointmentForm = document.getElementById("appointmentForm");
  const appointmentMessage = document.getElementById("appointmentMessage");

  const contactNumberInput = document.getElementById("contactNumber");
  const purposeSelect = document.getElementById("purpose");
  const notesInput = document.getElementById("notes");
  const preferredDateInput = document.getElementById("preferredDate");

  const appointmentModalEl = document.getElementById("appointmentModal");
  const submitBtn = document.getElementById("submitAppointmentBtn");

  const customTimeDropdown = document.getElementById("customTimeDropdown");
  const customTimeSelected = document.getElementById("customTimeSelected");
  const customTimeMenu = document.getElementById("customTimeMenu");
  const appointmentTimeInput = document.getElementById("appointmentTime");

  let appointmentModalInstance = null;
  let bookingPicker = null, inFlight = false, checkingReview = false, reviewedPayload = null, bookingAttempt = null;
  const pendingRequestStorageKey = "wmo_appointment_pending_request_key";
  try {
    const savedKey = window.sessionStorage?.getItem(pendingRequestStorageKey);
    if (savedKey && /^[A-Za-z0-9_-]{20,128}$/.test(savedKey)) bookingAttempt = { key: savedKey, payload: null, restored: true };
  } catch (_) { /* In-memory retry protection remains when browser storage is unavailable. */ }
  function clearBookingAttempt() {
    bookingAttempt = null;
    try { window.sessionStorage?.removeItem(pendingRequestStorageKey); } catch (_) { /* No citizen details are stored. */ }
  }
  const review = document.getElementById("appointmentReview");
  const editView = document.getElementById("appointmentEditView");
  const modalBody = document.getElementById("appointmentModalBody");
  const backBtn = document.getElementById("editAppointmentReview");
  const cancelBtn = document.getElementById("cancelAppointmentRequest");
  const refreshControl = document.getElementById("retryAppointmentAvailability");
  let editScrollTop = 0, editFocus = purposeSelect;
  function setReviewView(isReview, { focus = false } = {}) {
    if (isReview && review?.hidden) editScrollTop = modalBody?.scrollTop || 0;
    if (editView) { editView.hidden = isReview; editView.inert = isReview; }
    if (review) review.hidden = !isReview;
    if (backBtn) backBtn.hidden = !isReview;
    if (cancelBtn) cancelBtn.hidden = isReview;
    const activeStep = isReview ? 3 : !purposeSelect?.value ? 0 : !preferredDateInput?.value ? 1 : 2;
    ["Service", "Date", "Time", "Review"].forEach((step, index) => {
      const indicator = document.getElementById(`appointmentStep${step}`);
      if (index === activeStep) indicator?.setAttribute("aria-current", "step");
      else indicator?.removeAttribute("aria-current");
    });
    if (focus) {
      const target = isReview ? document.getElementById("appointmentReviewTitle") : editFocus;
      (target?.disabled ? purposeSelect : target)?.focus({ preventScroll: true });
      if (modalBody) modalBody.scrollTop = isReview ? 0 : editScrollTop;
    }
  }
  function editReview() {
    const wasReviewing = review?.hidden === false;
    reviewedPayload = null;
    setReviewView(false, { focus: wasReviewing });
    setSubmitButtonLoading(inFlight);
  }
  editView?.addEventListener("focusin", event => { if (event.target.id) editFocus = event.target; });

  if (appointmentModalEl && window.bootstrap) {
    appointmentModalInstance = bootstrap.Modal.getOrCreateInstance(appointmentModalEl);
  }

  function showMessage(message, type = "danger") {
    if (!appointmentMessage) return;

    appointmentMessage.textContent = message;
    appointmentMessage.classList.remove("text-success", "text-danger", "text-secondary");

    if (type === "success") {
      appointmentMessage.classList.add("text-success");
    } else if (type === "neutral") {
      appointmentMessage.classList.add("text-secondary");
    } else {
      appointmentMessage.classList.add("text-danger");
    }
  }

  function clearMessage() {
    if (!appointmentMessage) return;

    appointmentMessage.textContent = "";
    appointmentMessage.classList.remove("text-success", "text-danger", "text-secondary");
  }

  function setSubmitButtonLoading(isLoading) {
    if (!submitBtn) return;

    submitBtn.disabled = isLoading || checkingReview;
    if (backBtn) backBtn.disabled = isLoading || checkingReview;
    if (cancelBtn) cancelBtn.disabled = isLoading || checkingReview;
    submitBtn.textContent = isLoading ? "Submitting..." : checkingReview ? "Checking time…" : reviewedPayload
      ? bookingAttempt ? "Recover Reference" : "Confirm Request"
      : bookingAttempt ? "Review Recovery Details" : "Review Request";
  }

  function setMinimumPreferredDate() {
    if (!preferredDateInput) return;

    // Recovery validates the original payload, which may now describe an elapsed slot.
    preferredDateInput.min = bookingAttempt ? "" : window.AppointmentSlots.today();
  }

  function resetAppointmentFormState() {
    if (!appointmentForm) return;

    appointmentForm.reset();
    bookingPicker?.reset();
    editReview();
    clearMessage();

    if (appointmentTimeInput) {
      appointmentTimeInput.value = "";
    }

    if (customTimeSelected) {
      customTimeSelected.innerHTML = `Select time slot <span>⌄</span>`;
    }

    if (customTimeDropdown) {
      customTimeDropdown.classList.remove("open");
    }

    if (notesInput) {
      notesInput.required = false;
      notesInput.placeholder = "Enter additional details";
    }

    setSubmitButtonLoading(false);
    setMinimumPreferredDate();
  }

  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }

      const tempInput = document.createElement("textarea");
      tempInput.value = text;
      tempInput.setAttribute("readonly", "");
      tempInput.style.position = "fixed";
      tempInput.style.left = "-9999px";

      document.body.appendChild(tempInput);
      tempInput.select();

      const copied = document.execCommand("copy");
      document.body.removeChild(tempInput);

      return copied;
    } catch (error) {
      console.error("Copy failed:", error);
      return false;
    }
  }

  function showAppointmentSuccessModal(appointmentCode, emailAddress) {
    const successModalEl = document.getElementById("appointmentSuccessModal");
    const successCodeEl = document.getElementById("successAppointmentCode");
    const copyBtn = document.getElementById("copyAppointmentCodeBtn");
    const goToStatusBtn = document.getElementById("goToCheckStatusBtn");

    if (successCodeEl) {
      successCodeEl.textContent = appointmentCode;
    }

    if (copyBtn) {
      copyBtn.onclick = async () => {
        const copied = await copyTextToClipboard(appointmentCode);

        copyBtn.textContent = copied ? "Copied!" : "Copy Failed";
        copyBtn.disabled = true;

        setTimeout(() => {
          copyBtn.textContent = "Copy Code";
          copyBtn.disabled = false;
        }, 1500);
      };
    }

    if (goToStatusBtn) {
      goToStatusBtn.onclick = () => {
        const statusCodeInput = document.getElementById("statusAppointmentCode");
        const statusContactInput = document.getElementById("statusContact");
        const statusSection = document.getElementById("appointmentStatusSection");

        if (statusCodeInput) statusCodeInput.value = appointmentCode;
        if (statusContactInput) statusContactInput.value = emailAddress;

        if (successModalEl && window.bootstrap) {
          bootstrap.Modal.getOrCreateInstance(successModalEl).hide();
        }

        setTimeout(() => {
          if (statusSection) {
            statusSection.scrollIntoView({
              behavior: "smooth",
              block: "start"
            });
          }

          if (statusCodeInput) {
            statusCodeInput.focus();
          }
        }, 300);
      };
    }

    if (successModalEl && window.bootstrap) {
      bootstrap.Modal.getOrCreateInstance(successModalEl).show();
    } else {
      alert(`Appointment submitted successfully.\nReference Code: ${appointmentCode}`);
    }
  }

  if (contactNumberInput) {
    contactNumberInput.addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "").slice(0, 11);
    });
  }

  if (purposeSelect && notesInput) {
    purposeSelect.addEventListener("change", function () {
      if (this.value === "Others") {
        notesInput.required = true;
        notesInput.placeholder = "Please specify your service";
      } else {
        notesInput.required = false;
        notesInput.placeholder = "Enter additional details";
      }
    });
  }

  if (window.AppointmentSlots && preferredDateInput && appointmentTimeInput) {
    bookingPicker = window.AppointmentSlots.picker({
      service: () => purposeSelect.value, date: preferredDateInput, input: appointmentTimeInput,
      container: customTimeMenu, status: document.getElementById("appointmentAvailabilityStatus"),
      base: getAppApiBase, recovery: () => Boolean(bookingAttempt), changed: editReview, refreshControl
    });
    preferredDateInput.addEventListener("change", () => bookingPicker.refresh());
    purposeSelect.addEventListener("change", () => bookingPicker.refresh());
    refreshControl?.addEventListener("click", () => {
      if (!refreshControl.disabled) return bookingPicker.refresh();
    });
    bookingPicker.refresh();
  }
  for (const id of ["fullName", "barangay", "contactNumber", "emailAddress", "notes", "purpose", "preferredDate", "appointmentTime"]) {
    document.getElementById(id)?.addEventListener("input", editReview);
  }
  backBtn?.addEventListener("click", () => { if (!inFlight && !checkingReview) editReview(); });

  setMinimumPreferredDate();

  if (appointmentModalEl) {
    appointmentModalEl.addEventListener("hidden.bs.modal", () => {
      resetAppointmentFormState();
    });
  }

  if (!appointmentForm) return;

  function readBookingPayload() {
    return {
      full_name: document.getElementById("fullName")?.value.trim() || "",
      barangay: document.getElementById("barangay")?.value || "",
      contact_number: contactNumberInput?.value.trim() || "",
      email: document.getElementById("emailAddress")?.value.trim() || "",
      purpose: purposeSelect?.value || "",
      preferred_date: `${preferredDateInput?.value || ""} ${appointmentTimeInput?.value || ""}:00`,
      notes: notesInput?.value.trim() || ""
    };
  }

  appointmentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (inFlight || checkingReview) return;

    const payload = readBookingPayload();
    const { full_name: fullName, barangay, contact_number: contactNumber, email: emailAddress, purpose, notes } = payload;
    const preferredDate = document.getElementById("preferredDate")?.value || "";
    const preferredTime = document.getElementById("appointmentTime")?.value || "";

    if (!fullName || !barangay || !contactNumber || !emailAddress || !purpose || !preferredDate || !preferredTime) {
      showMessage("Please fill in all required fields.");
      return;
    }

    if (!/^\d{11}$/.test(contactNumber)) {
      showMessage("Contact number must be exactly 11 digits.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)) {
      showMessage("Please enter a valid email address.");
      return;
    }

    if (purpose === "Others" && !notes) {
      showMessage("Please specify your service in Additional Notes.");
      return;
    }

    const apiUrl = getAppointmentsCreateApiUrl();

    if (!apiUrl) {
      showMessage("API is not configured yet. Please check js/config.js or APP_CONFIG.API_BASE_URL.");
      return;
    }

    const recovering = Boolean(bookingAttempt);
    if (!bookingPicker?.selected()) {
      showMessage("Check availability and choose an available time before submitting."); return;
    }
    const serialized = JSON.stringify(payload);
    if (bookingAttempt && bookingAttempt.payload !== null && bookingAttempt.payload !== serialized) {
      showMessage("Your previous submission outcome is uncertain. Restore its details and retry, or contact WMO before creating another request."); return;
    }
    if (reviewedPayload !== serialized) {
      if (!recovering) {
        checkingReview = true;
        setSubmitButtonLoading(false);
        try {
          await bookingPicker.refresh({ preserveSelection: true });
        } finally {
          checkingReview = false;
          setSubmitButtonLoading(false);
        }
        if (!bookingPicker.selected()) {
          showMessage("Check availability and choose an available time before reviewing."); return;
        }
        if (JSON.stringify(readBookingPayload()) !== serialized) {
          showMessage("Your details changed while checking availability. Please review them again."); return;
        }
      }
      reviewedPayload = serialized;
      const summary = {
        Service: purpose,
        Date: new Date(`${preferredDate}T00:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "long", day: "numeric" }),
        Time: window.AppointmentSlots.label(preferredTime), Name: fullName, Barangay: barangay,
        Contact: contactNumber, Email: emailAddress, Notes: notes
      };
      for (const [field, value] of Object.entries(summary)) {
        const element = document.getElementById(`appointmentReview${field}`);
        if (element) element.textContent = value;
      }
      const notesSection = document.getElementById("appointmentReviewNotesSection");
      if (notesSection) notesSection.hidden = !notes;
      const reviewTitle = document.getElementById("appointmentReviewTitle");
      if (reviewTitle) reviewTitle.textContent = recovering ? "Review original request details for recovery" : "Review your appointment";
      const reviewNotice = document.getElementById("appointmentReviewNotice");
      if (reviewNotice) reviewNotice.textContent = recovering
        ? "Recovery checks your original request key and matching details. It cannot create a booking or reserve another slot. If no booking is found, retry recovery or contact WMO."
        : "A successful request reserves this service and time pending WMO approval. Save your reference code after submission.";
      clearMessage();
      setReviewView(true, { focus: true });
      setSubmitButtonLoading(false);
      return;
    }
    if (!bookingAttempt) {
      if (!window.crypto?.randomUUID) { showMessage("Secure booking identifiers are unavailable. Use an up-to-date browser over HTTPS."); return; }
      bookingAttempt = { payload: serialized, key: window.crypto.randomUUID() };
      try { window.sessionStorage?.setItem(pendingRequestStorageKey, bookingAttempt.key); } catch (_) { /* Retry in this tab remains supported. */ }
    }
    inFlight = true;
    const controller = window.AbortController ? new window.AbortController() : null;
    const submissionTimeout = controller ? setTimeout(() => controller.abort(), 20000) : null;
    showMessage("Submitting appointment request...", "neutral");
    setSubmitButtonLoading(true);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": bookingAttempt.key,
          ...(recovering ? { "Idempotency-Recovery": "true" } : {})
        },
        body: serialized,
        ...(controller ? { signal: controller.signal } : {})
      });

      const rawText = await response.text();

      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        console.error("Invalid JSON response:", rawText);
        showMessage("Server returned an invalid response.");
        setSubmitButtonLoading(false);
        return;
      }

      if (!response.ok || data.success !== true) {
        showMessage(data.message || "Failed to submit appointment request.");
        if (!recovering && (response.status === 400 || data.code === "SLOT_UNAVAILABLE")) {
          clearBookingAttempt(); editReview(); await bookingPicker.refresh();
        }
        return;
      }

      const appointmentCode =
        data.appointment_code ||
        data.referenceCode ||
        data.reference_code ||
        "Not generated";

      if (!/^APT-\d{6,20}$/.test(appointmentCode)) throw new Error("The server did not confirm a reference. Retry the same request or contact WMO.");
      clearBookingAttempt();
      clearMessage();

      if (appointmentModalInstance) {
        appointmentModalInstance.hide();
      } else if (appointmentModalEl) {
        appointmentModalEl.classList.remove("show");
        appointmentModalEl.style.display = "none";
      }

      setTimeout(() => {
        resetAppointmentFormState();
        showAppointmentSuccessModal(appointmentCode, emailAddress);
      }, 350);
    } catch (error) {
      console.error("Appointment submit error:", error);
      showMessage("The submission could not be confirmed. Retry without changing details to recover the same request, or contact WMO.");
    } finally {
      if (submissionTimeout !== null) clearTimeout(submissionTimeout);
      inFlight = false;
      setMinimumPreferredDate();
      bookingPicker?.syncRecovery();
      setSubmitButtonLoading(false);
    }
  });
}

/* =========================================================
   APPOINTMENT STATUS CHECKER
========================================================= */

function setupAppointmentStatusChecker() {
  const checkStatusForm = document.getElementById("checkAppointmentStatusForm");
  const statusResult = document.getElementById("appointmentStatusResult");
  const statusContactInput = document.getElementById("statusContact");
  const checkStatusBtn = document.getElementById("checkAppointmentStatusBtn");
  const statusModalEl = document.getElementById("appointmentStatusModal");
  const statusModalBody = document.getElementById("appointmentStatusModalBody");

  let statusModalInstance = null;

  if (statusModalEl && window.bootstrap) {
    statusModalInstance = bootstrap.Modal.getOrCreateInstance(statusModalEl);
  }

  if (statusContactInput) {
    statusContactInput.addEventListener("input", function () {
      if (/^\d+$/.test(this.value)) {
        this.value = this.value.replace(/\D/g, "").slice(0, 11);
      }
    });
  }

  if (!checkStatusForm || !statusResult) return;

  function setCheckButtonLoading(isLoading) {
    if (!checkStatusBtn) return;

    checkStatusBtn.disabled = isLoading;
    checkStatusBtn.textContent = isLoading ? "Checking..." : "Check Status";
  }

  function clearStatusMessage() {
    statusResult.innerHTML = "";
  }

  checkStatusForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const appointmentCode = document.getElementById("statusAppointmentCode")?.value.trim() || "";
    const contact = document.getElementById("statusContact")?.value.trim() || "";

    if (!appointmentCode || !contact) {
      renderStatusMessage("Please enter your reference code and email/contact number.", "danger");
      return;
    }

    const isOnlyNumbers = /^\d+$/.test(contact);

    if (isOnlyNumbers) {
      if (contact.length !== 11) {
        renderStatusMessage("Contact number must be exactly 11 digits.", "danger");
        return;
      }
    } else {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!contact.includes("@")) {
        renderStatusMessage("Email must contain @.", "danger");
        return;
      }

      if (!emailPattern.test(contact)) {
        renderStatusMessage("Please enter a valid email address.", "danger");
        return;
      }
    }

    const apiUrl = getAppointmentCheckStatusApiUrl();

    if (!apiUrl) {
      renderStatusMessage(
        "API is not configured yet. Please check js/config.js or APP_CONFIG.API_BASE_URL.",
        "danger"
      );
      return;
    }

    clearStatusMessage();
    setCheckButtonLoading(true);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          appointment_code: appointmentCode,
          contact
        })
      });

      const rawText = await response.text();

      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        console.error("Invalid appointment status response:", rawText);
        renderStatusMessage("Server returned an invalid response.", "danger");
        return;
      }

      if (!response.ok || !data.success) {
        renderStatusMessage(data.message || "Appointment not found.", "danger");
        return;
      }

      clearStatusMessage();
      renderAppointmentStatus(data.appointment);
    } catch (error) {
      console.error("Check appointment status error:", error);
      renderStatusMessage("Unable to check status. Please try again.", "danger");
    } finally {
      setCheckButtonLoading(false);
    }
  });

  function renderStatusMessage(message, type = "info") {
    statusResult.innerHTML = `
      <div class="alert alert-${escapeLandingHtml(type)} status-check-feedback mb-0" role="alert">
        ${escapeLandingHtml(message)}
      </div>
    `;
  }

  function renderAppointmentStatus(app) {
    if (!app || !statusModalBody) return;

    const status = formatLandingStatus(app.status);
    const statusClass = String(app.status || "pending").toLowerCase();

    statusModalBody.innerHTML = `
      <div class="appointment-status-modal-summary">
        <div>
          <span class="appointment-status-summary-label">Reference Code</span>
          <strong>${escapeLandingHtml(app.appointment_code || "-")}</strong>
        </div>

        <span class="status-pill ${escapeLandingHtml(statusClass)}">
          ${escapeLandingHtml(status)}
        </span>
      </div>

      <div class="appointment-status-detail-grid">
        <div class="appointment-status-detail-item">
          <span>Name</span>
          <strong>${escapeLandingHtml(app.full_name || "-")}</strong>
        </div>

        <div class="appointment-status-detail-item">
          <span>Barangay</span>
          <strong>${escapeLandingHtml(app.barangay || "-")}</strong>
        </div>

        <div class="appointment-status-detail-item">
          <span>Purpose</span>
          <strong>${escapeLandingHtml(app.purpose || "-")}</strong>
        </div>

        <div class="appointment-status-detail-item">
          <span>Appointment Date</span>
          <strong>${escapeLandingHtml(formatLandingDateTime(app.preferred_date))}</strong>
        </div>

        <div class="appointment-status-detail-item">
          <span>Handled By</span>
          <strong>${escapeLandingHtml(app.assigned_to || "Not yet assigned")}</strong>
        </div>

        <div class="appointment-status-detail-item">
          <span>Last Updated</span>
          <strong>${escapeLandingHtml(formatLandingDateTime(app.updated_at))}</strong>
        </div>
      </div>
    `;

    if (statusModalInstance) {
      statusModalInstance.show();
    } else if (statusModalEl) {
      statusModalEl.classList.add("show");
      statusModalEl.style.display = "block";
      statusModalEl.removeAttribute("aria-hidden");
    }
  }
}

/* =========================================================
   SCROLL REVEAL ANIMATION
========================================================= */

function setupScrollRevealAnimations() {
  const revealTargets = [
    { selector: ".hero-copy", effect: "reveal-left" },
    { selector: ".hero-visual-wrap", effect: "reveal-right" },

    { selector: ".section-heading", effect: "reveal-up" },
    { selector: ".service-card", effect: "reveal-service-drop", stagger: true },

    { selector: ".status-card-copy", effect: "reveal-left" },
    { selector: ".status-check-form", effect: "reveal-right" },

    { selector: ".footer-brand", effect: "reveal-left" },
    { selector: ".footer-description", effect: "reveal-up" },
    { selector: ".footer-links", effect: "reveal-right" }
  ];

  const elements = [];

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  revealTargets.forEach((item) => {
    document.querySelectorAll(item.selector).forEach((element, index) => {
      element.classList.add("reveal-ready", item.effect);

      if (item.stagger) {
        element.style.setProperty("--service-reveal-delay", `${index * 80}ms`);
      }

      elements.push(element);
    });
  });

  if (!elements.length) return;

  if (!("IntersectionObserver" in window)) {
    elements.forEach((element) => {
      element.classList.add("reveal-show");
    });
    return;
  }

  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("reveal-show");
          if (entry.target.classList.contains("service-card")) {
            revealObserver.unobserve(entry.target);
          }
        } else {
          if (!entry.target.classList.contains("service-card")) {
            entry.target.classList.remove("reveal-show");
          }
        }
      });
    },
    {
      threshold: 0.16,
      rootMargin: "0px 0px -70px 0px"
    }
  );

  elements.forEach((element) => {
    revealObserver.observe(element);
  });
}

/* =========================================================
   FORMATTERS / UTILITIES
========================================================= */

function formatLandingStatus(status) {
  const value = String(status || "pending").toLowerCase();

  if (value === "approved") return "Approved";
  if (value === "rescheduled") return "Rescheduled";
  if (value === "cancelled") return "Cancelled";
  if (value === "rejected") return "Rejected";
  if (value === "completed") return "Completed";

  return "Pending";
}

function formatLandingDate(dateValue) {
  if (!dateValue) return "-";

  return new Date(dateValue).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
}

function formatLandingDateTime(dateValue) {
  if (!dateValue) return "-";

  return new Date(dateValue).toLocaleString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function escapeLandingHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
