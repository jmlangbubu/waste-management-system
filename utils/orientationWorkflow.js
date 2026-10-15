const ORIENTATION_PURPOSE = "SWM Orientation & Clearance";
const TERMINAL_ORIENTATION_STATUSES = new Set([
  "completed_orientation",
  "incomplete_orientation"
]);
const WEB_ORIENTATION_ANSWERS = [
  "Banana peel",
  "Separate and clean them",
  "To make disposal and recycling easier",
  "Everyone",
  "A certificate can be issued and printed"
];

function normalizeOrientationStatus(value) {
  return String(value || "approved").trim().toLowerCase();
}

function getOrientationQuizResult(score, totalQuestions, answers) {
  if (score === null || score === undefined || score === "" || typeof score === "boolean") {
    return null;
  }
  if (totalQuestions === null || totalQuestions === "" || typeof totalQuestions === "boolean") {
    return null;
  }
  const total = totalQuestions === undefined ? 10 : Number(totalQuestions);
  let numericScore = Number(score);
  if (!Number.isInteger(total) || ![5, 10].includes(total) ||
      !Number.isInteger(numericScore) || numericScore < 0 || numericScore > total) {
    return null;
  }
  if (total === 5) {
    if (!Array.isArray(answers) || answers.length !== WEB_ORIENTATION_ANSWERS.length) return null;
    const verifiedScore = answers.reduce((count, answer, index) =>
      count + (answer === WEB_ORIENTATION_ANSWERS[index] ? 1 : 0), 0);
    if (verifiedScore !== numericScore) return null;
    numericScore = verifiedScore;
  }
  return {
    score: numericScore,
    totalQuestions: total,
    passed: numericScore >= (total === 5 ? 4 : 8)
  };
}

function canTakeOrientationQuiz(status) {
  return ["approved", "pending_orientation", "ready_for_retake"].includes(
    normalizeOrientationStatus(status)
  );
}

module.exports = {
  ORIENTATION_PURPOSE,
  TERMINAL_ORIENTATION_STATUSES,
  normalizeOrientationStatus,
  getOrientationQuizResult,
  WEB_ORIENTATION_ANSWERS,
  canTakeOrientationQuiz
};
