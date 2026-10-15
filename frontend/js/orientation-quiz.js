const quizQuestions = [
  {
    question: "Which of the following is biodegradable waste?",
    options: ["Plastic bottle", "Banana peel", "Glass jar", "Battery"],
    answer: "Banana peel"
  },
  {
    question: "What should be done before disposing of recyclable materials?",
    options: ["Burn them", "Mix with food waste", "Separate and clean them", "Throw anywhere"],
    answer: "Separate and clean them"
  },
  {
    question: "Why is waste segregation important?",
    options: [
      "To increase mixed garbage",
      "To make disposal and recycling easier",
      "To avoid collection",
      "To hide waste"
    ],
    answer: "To make disposal and recycling easier"
  },
  {
    question: "Who should follow proper waste management practices?",
    options: ["Only barangay officials", "Only WMO staff", "Everyone", "Only business owners"],
    answer: "Everyone"
  },
  {
    question: "What happens after passing the SWM orientation exam?",
    options: [
      "Nothing",
      "A certificate can be issued and printed",
      "Mobile phone is required",
      "The record is deleted"
    ],
    answer: "A certificate can be issued and printed"
  }
];

let verifiedOrientationData = null;
let latestScore = 0;
let quizSubmissionInFlight = false;

function getApiBase() {
  if (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) {
    return window.APP_CONFIG.API_BASE_URL;
  }
  return "";
}

function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}

function formatSimpleDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function showElement(id) {
  document.getElementById(id)?.classList.remove("hidden");
}

function hideElement(id) {
  document.getElementById(id)?.classList.add("hidden");
}

async function verifyOrientationToken(token) {
  const url = `${getApiBase()}/appointments/orientation/verify/${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    }
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.message || "Failed to verify orientation token.");
  }

  return data.data;
}

function populateParticipantDetails(data, token) {
  document.getElementById("participantName").textContent = data.full_name || "-";
  document.getElementById("participantBarangay").textContent = data.barangay || "-";
  document.getElementById("participantPurpose").textContent = data.purpose || "-";
  document.getElementById("participantDate").textContent = formatSimpleDate(data.preferred_date);
  document.getElementById("participantToken").textContent = token;

  document.getElementById("certificateFullName").textContent = data.full_name || "-";
  document.getElementById("certificateBarangay").textContent = data.barangay || "-";
  document.getElementById("certificateDate").textContent = new Date().toLocaleDateString();
  document.getElementById("certificateToken").textContent = token;
}

function renderQuizQuestions() {
  const form = document.getElementById("orientationQuizForm");
  if (!form) return;

  form.innerHTML = quizQuestions.map((item, index) => `
    <div class="quiz-question">
      <h3>${index + 1}. ${item.question}</h3>
      ${item.options.map((option) => `
        <label class="quiz-option">
          <input type="radio" name="question_${index}" value="${option}">
          <span>${option}</span>
        </label>
      `).join("")}
    </div>
  `).join("");
}

function calculateQuizScore() {
  let score = 0;

  quizQuestions.forEach((item, index) => {
    const selected = document.querySelector(`input[name="question_${index}"]:checked`);
    if (selected && selected.value === item.answer) {
      score += 1;
    }
  });

  return score;
}

async function startQuiz() {
  const token = getTokenFromUrl();
  const button = document.getElementById("btnStartQuiz");
  if (button) button.disabled = true;
  try {
    const response = await fetch(`${getApiBase()}/appointments/orientation/start/${encodeURIComponent(token)}`, {
      method: "PUT",
      headers: { Accept: "application/json" }
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Unable to start the exam.");
    hideElement("participantPanel");
    hideElement("quizErrorState");
    showElement("quizPanel");
    renderQuizQuestions();
  } catch (error) {
    const errorState = document.getElementById("quizErrorState");
    errorState.textContent = error.message || "Unable to start the exam.";
    showElement("quizErrorState");
  } finally {
    if (button) button.disabled = false;
  }
}

async function submitQuiz() {
  if (quizSubmissionInFlight) return;
  latestScore = calculateQuizScore();
  const answers = quizQuestions.map((_, index) =>
    document.querySelector(`input[name="question_${index}"]:checked`)?.value || null);
  const submitButton = document.getElementById("btnSubmitQuiz");
  const resultText = document.getElementById("quizResultText");
  const retryBtn = document.getElementById("btnRetryQuiz");
  quizSubmissionInFlight = true;
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch(
      `${getApiBase()}/appointments/orientation/complete/${encodeURIComponent(getTokenFromUrl())}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ score: latestScore, total_questions: quizQuestions.length, answers })
      }
    );
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Unable to save the exam result.");
    hideElement("quizPanel");
    hideElement("quizErrorState");
    showElement("quizResultPanel");
    if (data.passed && data.certificate_eligible) {
      resultText.textContent = `Passed! Your score is ${data.score} out of ${quizQuestions.length}.`;
      hideElement("btnRetryQuiz");
      showElement("certificatePanel");
    } else {
      resultText.textContent = `Failed. Your score is ${data.score} out of ${quizQuestions.length}. Ask WMO to allow a retake before trying again.`;
      retryBtn.textContent = "Check Retake Authorization";
      showElement("btnRetryQuiz");
      hideElement("certificatePanel");
    }
  } catch (error) {
    const errorState = document.getElementById("quizErrorState");
    errorState.textContent = error.message || "Unable to save the exam result.";
    showElement("quizErrorState");
  } finally {
    quizSubmissionInFlight = false;
    if (submitButton) submitButton.disabled = false;
  }
}

async function retryQuiz() {
  const resultText = document.getElementById("quizResultText");
  try {
    const state = await verifyOrientationToken(getTokenFromUrl());
    if (!state.can_take_quiz || state.orientation_status !== "ready_for_retake") {
      resultText.textContent = "A retake has not yet been authorized by WMO.";
      return;
    }
    const response = await fetch(
      `${getApiBase()}/appointments/orientation/start/${encodeURIComponent(getTokenFromUrl())}`,
      { method: "PUT", headers: { Accept: "application/json" } }
    );
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || "Unable to restart the exam.");
    hideElement("quizResultPanel");
    hideElement("certificatePanel");
    showElement("quizPanel");
    renderQuizQuestions();
  } catch (error) {
    resultText.textContent = error.message || "Unable to check retake authorization.";
  }
}

function printCertificate() {
  window.print();
}

async function initializeWebOrientationQuiz() {
  const token = getTokenFromUrl();
  const loading = document.getElementById("quizLoadingState");
  const errorState = document.getElementById("quizErrorState");

  if (!token) {
    loading.classList.add("hidden");
    errorState.textContent = "Missing orientation token.";
    errorState.classList.remove("hidden");
    return;
  }

  try {
    verifiedOrientationData = await verifyOrientationToken(token);
    populateParticipantDetails(verifiedOrientationData, token);

    hideElement("quizLoadingState");
    if (verifiedOrientationData.can_take_quiz) {
      showElement("participantPanel");
    } else {
      errorState.textContent = verifiedOrientationData.orientation_status === "failed_orientation"
        ? "A retake must be authorized by WMO before this exam can continue. Refresh after authorization."
        : "This orientation is no longer available for an exam.";
      showElement("quizErrorState");
    }
  } catch (error) {
    hideElement("quizLoadingState");
    errorState.textContent = error.message || "Failed to verify orientation token.";
    errorState.classList.remove("hidden");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btnStartQuiz")?.addEventListener("click", startQuiz);
  document.getElementById("btnSubmitQuiz")?.addEventListener("click", submitQuiz);
  document.getElementById("btnRetryQuiz")?.addEventListener("click", retryQuiz);
  document.getElementById("btnPrintCertificate")?.addEventListener("click", printCertificate);

  initializeWebOrientationQuiz();
});
