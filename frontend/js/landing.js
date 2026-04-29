function getAppApiBase() {
  if (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) {
    return window.APP_CONFIG.API_BASE_URL;
  }

  if (window.API_BASE) {
    return window.API_BASE;
  }

  console.error("API BASE URL is not defined. Check config.js / APP_CONFIG.");
  return "";
}

function getAppointmentsCreateApiUrl() {
  return `${getAppApiBase()}/appointments`;
}

function getAppointmentCheckStatusApiUrl() {
  return `${getAppApiBase()}/appointments/check-status`;
}

document.addEventListener("DOMContentLoaded", () => {
  const appointmentForm = document.getElementById("appointmentForm");
const appointmentMessage = document.getElementById("appointmentMessage");
const statusContactInput = document.getElementById("statusContact");
const contactNumberInput = document.getElementById("contactNumber");

if (statusContactInput) {
  statusContactInput.addEventListener("input", function () {
   
    if (/^\d+$/.test(this.value)) {
      this.value = this.value.replace(/\D/g, "").slice(0, 11);
    }
  });
}
  const purposeSelect = document.getElementById("purpose");
  const notesInput = document.getElementById("notes");
  const preferredDateInput = document.getElementById("preferredDate");
  const appointmentModalEl = document.getElementById("appointmentModal");
  const submitBtn = document.getElementById("submitAppointmentBtn");

  const checkStatusForm = document.getElementById("checkAppointmentStatusForm");
  const statusResult = document.getElementById("appointmentStatusResult");

  const customTimeDropdown = document.getElementById("customTimeDropdown");
  const customTimeSelected = document.getElementById("customTimeSelected");
  const customTimeMenu = document.getElementById("customTimeMenu");
  const appointmentTimeInput = document.getElementById("appointmentTime");

  let appointmentModalInstance = null;

  if (appointmentModalEl && window.bootstrap) {
    appointmentModalInstance = bootstrap.Modal.getOrCreateInstance(appointmentModalEl);
  }

  if (customTimeDropdown && customTimeSelected && customTimeMenu && appointmentTimeInput) {
    customTimeSelected.addEventListener("click", (event) => {
      event.stopPropagation();
      customTimeDropdown.classList.toggle("open");
    });

    customTimeMenu.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        appointmentTimeInput.value = btn.dataset.time || "";
        customTimeSelected.innerHTML = `${btn.textContent.trim()} <span>⌄</span>`;
        customTimeDropdown.classList.remove("open");
      });
    });

    document.addEventListener("click", (event) => {
      if (!customTimeDropdown.contains(event.target)) {
        customTimeDropdown.classList.remove("open");
      }
    });
  }

  function showMessage(message, isSuccess = false) {
    if (!appointmentMessage) return;
    appointmentMessage.innerHTML = message;
    appointmentMessage.classList.remove("text-success", "text-danger", "text-secondary");
    appointmentMessage.classList.add(isSuccess ? "text-success" : "text-danger");
  }

  function showNeutralMessage(message) {
    if (!appointmentMessage) return;
    appointmentMessage.textContent = message;
    appointmentMessage.classList.remove("text-success", "text-danger");
    appointmentMessage.classList.add("text-secondary");
  }

  function clearMessage() {
    if (!appointmentMessage) return;
    appointmentMessage.textContent = "";
    appointmentMessage.classList.remove("text-success", "text-danger", "text-secondary");
  }

  function resetAppointmentFormState() {
    if (!appointmentForm) return;

    appointmentForm.reset();
    clearMessage();

    if (appointmentTimeInput) appointmentTimeInput.value = "";
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

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Request";
    }

    setMinimumPreferredDate();
  }

  function setMinimumPreferredDate() {
    if (!preferredDateInput) return;

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");

    preferredDateInput.min = `${yyyy}-${mm}-${dd}`;
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

  setMinimumPreferredDate();

  if (appointmentModalEl) {
    appointmentModalEl.addEventListener("hidden.bs.modal", () => {
      resetAppointmentFormState();
    });
  }

  if (appointmentForm) {
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

      showNeutralMessage("Submitting appointment request...");

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = "Submitting...";
        }

        const response = await fetch(getAppointmentsCreateApiUrl(), {
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
          return;
        }

        if (!response.ok || !data.success) {
          showMessage(data.message || "Failed to submit appointment request.");
          return;
        }

        const appointmentCode = data.appointment_code || "Not generated";

        showMessage(
          `
          Appointment request submitted successfully.<br>
          <strong>Reference Code:</strong> ${escapeLandingHtml(appointmentCode)}<br>
          <span>Please save this code. You can use it with your email or contact number to check your appointment status.</span>
          `,
          true
        );

        setTimeout(() => {
          alert(`Appointment submitted successfully.\nReference Code: ${appointmentCode}`);
        }, 300);
      } catch (error) {
        console.error("Appointment submit error:", error);
        showMessage("Unable to connect to the server. Please try again.");
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Submit Request";
        }
      }
    });
  }

  if (checkStatusForm) {
    checkStatusForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const appointmentCode = document.getElementById("statusAppointmentCode")?.value.trim() || "";
      const contact = document.getElementById("statusContact")?.value.trim() || "";

      if (!appointmentCode || !contact) {
  renderStatusMessage("Please enter your reference code and email/contact number.", "danger");
  return;
}

// ✅ VALIDATION LOGIC
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

      renderStatusMessage("Checking appointment status...", "info");

      try {
        const response = await fetch(getAppointmentCheckStatusApiUrl(), {
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

        const data = await response.json();

        if (!response.ok || !data.success) {
          renderStatusMessage(data.message || "Appointment not found.", "danger");
          return;
        }

        renderAppointmentStatus(data.appointment);
      } catch (error) {
        console.error("Check appointment status error:", error);
        renderStatusMessage("Unable to check status. Please try again.", "danger");
      }
    });
  }

  function renderStatusMessage(message, type = "info") {
    if (!statusResult) return;

    statusResult.innerHTML = `
      <div class="alert alert-${type}">
        ${escapeLandingHtml(message)}
      </div>
    `;
  }

  function renderAppointmentStatus(app) {
    if (!statusResult || !app) return;

    const status = formatLandingStatus(app.status);

    statusResult.innerHTML = `
      <div class="status-result-card">
        <div class="d-flex justify-content-between align-items-start gap-3 flex-wrap mb-3">
          <div>
            <h3 class="h5 mb-1">Appointment Status</h3>
            <p class="text-secondary mb-0">Latest appointment update from WMO.</p>
          </div>
          <span class="status-pill">${escapeLandingHtml(status)}</span>
        </div>

        <div class="row g-3">
          <div class="col-md-6">
            <strong>Reference Code</strong>
            <p>${escapeLandingHtml(app.appointment_code)}</p>
          </div>

          <div class="col-md-6">
            <strong>Name</strong>
            <p>${escapeLandingHtml(app.full_name)}</p>
          </div>

          <div class="col-md-6">
            <strong>Barangay</strong>
            <p>${escapeLandingHtml(app.barangay)}</p>
          </div>

          <div class="col-md-6">
            <strong>Purpose</strong>
            <p>${escapeLandingHtml(app.purpose)}</p>
          </div>

          <div class="col-md-6">
            <strong>Appointment Date</strong>
            <p>${formatLandingDateTime(app.preferred_date)}</p>
          </div>

          <div class="col-md-6">
            <strong>Handled By</strong>
            <p>${escapeLandingHtml(app.assigned_to || "Not yet assigned")}</p>
          </div>

          <div class="col-12">
            <strong>Last Updated</strong>
            <p>${formatLandingDateTime(app.updated_at)}</p>
          </div>
        </div>
      </div>
    `;
  }
});

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
