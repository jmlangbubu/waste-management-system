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
  setupScrollRevealAnimations();
});

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

  if (appointmentModalEl && window.bootstrap) {
    appointmentModalInstance = bootstrap.Modal.getOrCreateInstance(appointmentModalEl);
  }

  function showMessage(message, type = "danger") {
    if (!appointmentMessage) return;

    appointmentMessage.innerHTML = message;
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

    submitBtn.disabled = isLoading;
    submitBtn.textContent = isLoading ? "Submitting..." : "Submit Request";
  }

  function setMinimumPreferredDate() {
    if (!preferredDateInput) return;

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");

    preferredDateInput.min = `${yyyy}-${mm}-${dd}`;
  }

  function resetAppointmentFormState() {
    if (!appointmentForm) return;

    appointmentForm.reset();
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
        notesInput.placeholder = "Please specify your purpose";
      } else {
        notesInput.required = false;
        notesInput.placeholder = "Enter additional details";
      }
    });
  }

  if (customTimeDropdown && customTimeSelected && customTimeMenu && appointmentTimeInput) {
    customTimeSelected.addEventListener("click", (event) => {
      event.stopPropagation();
      customTimeDropdown.classList.toggle("open");
    });

    customTimeMenu.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        const selectedTime = button.dataset.time || "";
        const selectedLabel = button.textContent.trim();

        appointmentTimeInput.value = selectedTime;
        customTimeSelected.innerHTML = `${selectedLabel} <span>⌄</span>`;
        customTimeDropdown.classList.remove("open");
      });
    });

    document.addEventListener("click", (event) => {
      if (!customTimeDropdown.contains(event.target)) {
        customTimeDropdown.classList.remove("open");
      }
    });
  }

  setMinimumPreferredDate();

  if (appointmentModalEl) {
    appointmentModalEl.addEventListener("hidden.bs.modal", () => {
      resetAppointmentFormState();
    });
  }

  if (!appointmentForm) return;

  appointmentForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fullName = document.getElementById("fullName")?.value.trim() || "";
    const barangay = document.getElementById("barangay")?.value || "";
    const contactNumber = document.getElementById("contactNumber")?.value.trim() || "";
    const emailAddress = document.getElementById("emailAddress")?.value.trim() || "";
    const purpose = document.getElementById("purpose")?.value || "";
    const preferredDate = document.getElementById("preferredDate")?.value || "";
    const preferredTime = document.getElementById("appointmentTime")?.value || "";
    const notes = document.getElementById("notes")?.value.trim() || "";

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
      showMessage("Please specify your purpose in Additional Notes.");
      return;
    }

    const apiUrl = getAppointmentsCreateApiUrl();

    if (!apiUrl) {
      showMessage("API is not configured yet. Please check js/config.js or APP_CONFIG.API_BASE_URL.");
      return;
    }

    const preferredDateTime = `${preferredDate} ${preferredTime}:00`;

    const payload = {
      full_name: fullName,
      barangay,
      contact_number: contactNumber,
      email: emailAddress,
      purpose,
      preferred_date: preferredDateTime,
      notes
    };

    showMessage("Submitting appointment request...", "neutral");
    setSubmitButtonLoading(true);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(payload)
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

      if (!response.ok || !data.success) {
        showMessage(data.message || "Failed to submit appointment request.");
        setSubmitButtonLoading(false);
        return;
      }

      const appointmentCode =
        data.appointment_code ||
        data.referenceCode ||
        data.reference_code ||
        "Not generated";

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
      showMessage("Unable to connect to the server. Please try again.");
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
    { selector: ".service-card", effect: "reveal-up", stagger: true },

    { selector: ".status-card-copy", effect: "reveal-left" },
    { selector: ".status-check-form", effect: "reveal-right" },

    { selector: ".footer-brand", effect: "reveal-left" },
    { selector: ".footer-description", effect: "reveal-up" },
    { selector: ".footer-links", effect: "reveal-right" }
  ];

  const elements = [];

  revealTargets.forEach((item) => {
    document.querySelectorAll(item.selector).forEach((element, index) => {
      element.classList.add("reveal-ready", item.effect);

      if (item.stagger) {
        const delayClass = `reveal-delay-${(index % 5) + 1}`;
        element.classList.add(delayClass);
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
        } else {
          entry.target.classList.remove("reveal-show");
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
