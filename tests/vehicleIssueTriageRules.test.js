const assert = require("node:assert/strict");
const {
  RULESET_VERSION,
  VehicleIssueTriageError,
  evaluateTriage,
  getAssistantSchema
} = require("../utils/vehicleIssueTriageRules");

const tests = [];
const test = (name, callback) => tests.push({ name, callback });

function safeAnswers(overrides = {}) {
  return {
    brakes_safe: true,
    steering_normal: true,
    smoke_fire_steam_present: false,
    serious_overheating: false,
    unsafe_tire: false,
    severe_power_loss: false,
    movement_safety: "safe",
    warning_indicator_persistent: false,
    noise_vibration_recurring: false,
    degraded_but_controllable: false,
    lights_affect_safe_visibility: false,
    ...overrides
  };
}

for (const [name, answers] of [
  ["unsafe brakes are critical", { brakes_safe: false }],
  ["unsafe steering is critical", { steering_normal: false }],
  ["smoke fire or steam is critical", { smoke_fire_steam_present: true }],
  ["serious overheating is critical", { serious_overheating: true }],
  ["unsafe tire is critical", { unsafe_tire: true }],
  ["severe power loss is critical", { severe_power_loss: true }],
  ["vehicle that cannot move safely is critical", { movement_safety: "unsafe" }],
  ["uncertain movement safety is critical", { movement_safety: "unsure" }],
  ["unsafe required lights are critical", { lights_affect_safe_visibility: true }]
]) {
  test(name, () => {
    assert.equal(evaluateTriage("other", safeAnswers(answers)).severity, "critical");
  });
}

test("persistent warning is moderate", () => {
  assert.equal(
    evaluateTriage("electrical_battery", safeAnswers({
      warning_indicator_persistent: true
    })).severity,
    "moderate"
  );
});

test("recurring noise or vibration is moderate", () => {
  assert.equal(
    evaluateTriage("noise_vibration", safeAnswers({
      noise_vibration_recurring: true
    })).severity,
    "moderate"
  );
});

test("degraded but controllable behavior is moderate", () => {
  assert.equal(
    evaluateTriage("other", safeAnswers({
      degraded_but_controllable: true
    })).severity,
    "moderate"
  );
});

test("minor safe issue is low", () => {
  const result = evaluateTriage("other", safeAnswers());
  assert.equal(result.severity, "low");
  assert.match(result.possible_concern, /^Potential/);
  assert.ok(!/confirmed|diagnosed/i.test(result.possible_concern));
});

test("other category cannot bypass a critical safety answer", () => {
  assert.equal(
    evaluateTriage("other", safeAnswers({ brakes_safe: false })).severity,
    "critical"
  );
});

test("missing answer is rejected", () => {
  const answers = safeAnswers();
  delete answers.brakes_safe;
  assert.throws(
    () => evaluateTriage("brakes", answers),
    (error) => error instanceof VehicleIssueTriageError &&
      error.code === "VEHICLE_ISSUE_ANSWER_REQUIRED"
  );
});

test("malformed answer JSON is rejected", () => {
  assert.throws(
    () => evaluateTriage("brakes", "{not json"),
    (error) => error.code === "VEHICLE_ISSUE_ANSWERS_MALFORMED"
  );
});

test("invalid category is rejected", () => {
  assert.throws(
    () => evaluateTriage("maintenance", safeAnswers()),
    (error) => error.code === "VEHICLE_ISSUE_CATEGORY_INVALID"
  );
});

test("assistant schema is machine-readable and versioned", () => {
  const schema = getAssistantSchema();
  assert.equal(schema.ruleset_version, RULESET_VERSION);
  assert.equal(schema.categories.length, 8);
  assert.equal(schema.questions.length, 11);
  assert.ok(schema.questions.every((question) => question.id && question.type));
});

(async () => {
  let passed = 0;
  for (const current of tests) {
    try {
      await current.callback();
      passed += 1;
      console.log(`PASS ${current.name}`);
    } catch (error) {
      console.error(`FAIL ${current.name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
  console.log(`${passed}/${tests.length} vehicle issue triage tests passed`);
})();
