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

function startQuiz() {
  hideElement("participantPanel");
  showElement("quizPanel");
  renderQuizQuestions();
}

function submitQuiz() {
  latestScore = calculateQuizScore();

  hideElement("quizPanel");
  showElement("quizResultPanel");

  const resultText = document.getElementById("quizResultText");
  const retryBtn = document.getElementById("btnRetryQuiz");

  if (latestScore >= 4) {
    resultText.textContent = `Passed! Your score is ${latestScore} out of ${quizQuestions.length}.`;
    hideElement("btnRetryQuiz");
    showElement("certificatePanel");
  } else {
    resultText.textContent = `Failed. Your score is ${latestScore} out of ${quizQuestions.length}. Passing score is 4.`;
    retryBtn.classList.remove("hidden");
    hideElement("certificatePanel");
  }
}

function retryQuiz() {
  hideElement("quizResultPanel");
  hideElement("certificatePanel");
  showElement("quizPanel");
  renderQuizQuestions();
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
    showElement("participantPanel");
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