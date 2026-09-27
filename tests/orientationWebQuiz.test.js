const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/js/orientation-quiz.js"), "utf8");

function loadQuiz(score, responseBody) {
  const nodes = new Map();
  const calls = [];
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set(["hidden"]);
      nodes.set(id, {
        textContent: "", disabled: false,
        classList: {
          add(value) { classes.add(value); },
          remove(value) { classes.delete(value); },
          contains(value) { return classes.has(value); }
        }
      });
    }
    return nodes.get(id);
  }
  const context = {
    window: { APP_CONFIG: { API_BASE_URL: "/api" }, location: { search: "?token=ORI-test" } },
    URLSearchParams,
    document: {
      addEventListener() {},
      getElementById: node,
      querySelector() { return null; }
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => responseBody };
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.calculateQuizScore = () => score;
  return { context, node, calls };
}

test("web quiz records a failed score and never reveals a certificate", async () => {
  const { context, node, calls } = loadQuiz(3, {
    success: true, passed: false, score: 3, certificate_eligible: false,
    orientation_status: "failed_orientation"
  });
  await context.submitQuiz();
  assert.equal(JSON.parse(calls[0].options.body).total_questions, 5);
  assert.equal(JSON.parse(calls[0].options.body).score, 3);
  assert.equal(JSON.parse(calls[0].options.body).answers.length, 5);
  assert.equal(node("certificatePanel").classList.contains("hidden"), true);
  assert.equal(node("btnRetryQuiz").classList.contains("hidden"), false);
  assert.match(node("quizResultText").textContent, /Ask WMO to allow a retake/);
});

test("web certificate becomes visible only after server confirms a passing result", async () => {
  const { context, node } = loadQuiz(4, {
    success: true, passed: true, score: 4, certificate_eligible: true,
    orientation_status: "completed_orientation"
  });
  await context.submitQuiz();
  assert.equal(node("certificatePanel").classList.contains("hidden"), false);
  assert.equal(node("btnRetryQuiz").classList.contains("hidden"), true);
});

test("a retake remains blocked until the server reports Ready for Retake", async () => {
  const { context, node, calls } = loadQuiz(0, {
    success: true, data: { can_take_quiz: false, orientation_status: "failed_orientation" }
  });
  await context.retryQuiz();
  assert.equal(calls.length, 1);
  assert.match(node("quizResultText").textContent, /not yet been authorized/);
});
