const RULESET_VERSION = "vehicle-issue-triage-v1";

const ISSUE_CATEGORIES = Object.freeze({
  engine_overheating: "Engine / Overheating",
  brakes: "Brakes",
  tires: "Tires",
  steering: "Steering",
  electrical_battery: "Electrical / Battery",
  lights: "Lights",
  noise_vibration: "Unusual Noise / Vibration",
  other: "Other"
});

const QUESTION_SCHEMA = Object.freeze([
  {
    id: "brakes_safe",
    prompt: "Are the brakes responding normally and safely?",
    type: "boolean",
    required: true,
    safe_answer: true
  },
  {
    id: "steering_normal",
    prompt: "Is the steering responding normally?",
    type: "boolean",
    required: true,
    safe_answer: true
  },
  {
    id: "smoke_fire_steam_present",
    prompt: "Is there smoke, fire, or steam from the vehicle?",
    type: "boolean",
    required: true,
    safe_answer: false
  },
  {
    id: "serious_overheating",
    prompt: "Is the temperature warning severe or is the vehicle seriously overheating?",
    type: "boolean",
    required: true,
    safe_answer: false,
    categories: ["engine_overheating"]
  },
  {
    id: "unsafe_tire",
    prompt: "Is any tire flat, visibly damaged, or unsafe for travel?",
    type: "boolean",
    required: true,
    safe_answer: false,
    categories: ["tires"]
  },
  {
    id: "severe_power_loss",
    prompt: "Is the vehicle experiencing severe or sudden power loss?",
    type: "boolean",
    required: true,
    safe_answer: false,
    categories: ["engine_overheating", "electrical_battery"]
  },
  {
    id: "movement_safety",
    prompt: "Can the vehicle be moved safely?",
    type: "single_choice",
    required: true,
    options: [
      { value: "safe", label: "Yes, it can be moved safely" },
      { value: "unsafe", label: "No, it cannot be moved safely" },
      { value: "unsure", label: "I cannot determine whether it is safe" }
    ],
    safe_answer: "safe"
  },
  {
    id: "warning_indicator_persistent",
    prompt: "Is a dashboard warning indicator persistent?",
    type: "boolean",
    required: true,
    safe_answer: false
  },
  {
    id: "noise_vibration_recurring",
    prompt: "Is unusual noise or vibration recurring or worsening?",
    type: "boolean",
    required: true,
    safe_answer: false,
    categories: ["noise_vibration"]
  },
  {
    id: "degraded_but_controllable",
    prompt: "Is vehicle behavior degraded but still controllable?",
    type: "boolean",
    required: true,
    safe_answer: false
  },
  {
    id: "lights_affect_safe_visibility",
    prompt: "Does the light problem affect safe visibility or required warning lights?",
    type: "boolean",
    required: true,
    safe_answer: false,
    categories: ["lights", "electrical_battery"]
  }
]);

class VehicleIssueTriageError extends Error {
  constructor(message, code = "VEHICLE_ISSUE_ANSWERS_INVALID") {
    super(message);
    this.name = "VehicleIssueTriageError";
    this.statusCode = 400;
    this.code = code;
  }
}

function normalizeCategory(value) {
  const category = String(value || "").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ISSUE_CATEGORIES, category)) {
    throw new VehicleIssueTriageError(
      "issue_category is not supported",
      "VEHICLE_ISSUE_CATEGORY_INVALID"
    );
  }
  return category;
}

function parseAnswers(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new VehicleIssueTriageError("assistant_answers is required");
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch (error) {
    throw new VehicleIssueTriageError(
      "assistant_answers must be a valid JSON object",
      "VEHICLE_ISSUE_ANSWERS_MALFORMED"
    );
  }
}

function normalizeAnswers(value) {
  const answers = parseAnswers(value);
  const normalized = {};

  for (const question of QUESTION_SCHEMA) {
    if (!Object.prototype.hasOwnProperty.call(answers, question.id)) {
      throw new VehicleIssueTriageError(
        `Missing required assistant answer: ${question.id}`,
        "VEHICLE_ISSUE_ANSWER_REQUIRED"
      );
    }

    const answer = answers[question.id];
    if (question.type === "boolean") {
      if (typeof answer !== "boolean") {
        throw new VehicleIssueTriageError(
          `${question.id} must be true or false`,
          "VEHICLE_ISSUE_ANSWER_INVALID"
        );
      }
      normalized[question.id] = answer;
      continue;
    }

    const allowed = new Set(question.options.map((option) => option.value));
    const clean = String(answer || "").trim().toLowerCase();
    if (!allowed.has(clean)) {
      throw new VehicleIssueTriageError(
        `${question.id} has an invalid answer`,
        "VEHICLE_ISSUE_ANSWER_INVALID"
      );
    }
    normalized[question.id] = clean;
  }

  return normalized;
}

function criticalReason(answers) {
  if (!answers.brakes_safe) {
    return "Potential brake-system safety concern.";
  }
  if (!answers.steering_normal) {
    return "Potential steering-control safety concern.";
  }
  if (answers.smoke_fire_steam_present) {
    return "Potential fire, smoke, or pressurized-steam hazard.";
  }
  if (answers.serious_overheating) {
    return "Potential serious overheating condition.";
  }
  if (answers.unsafe_tire) {
    return "Potential unsafe tire condition.";
  }
  if (answers.severe_power_loss) {
    return "Potential severe power or electrical-system concern.";
  }
  if (answers.movement_safety !== "safe") {
    return "Potential condition that makes continued vehicle movement unsafe or uncertain.";
  }
  if (answers.lights_affect_safe_visibility) {
    return "Potential visibility or required-warning-light safety concern.";
  }
  return "Potential immediate vehicle safety concern.";
}

function categoryConcern(category) {
  const concerns = {
    engine_overheating: "Potential engine-temperature or cooling-system concern.",
    brakes: "Potential brake-system concern.",
    tires: "Potential tire or wheel concern.",
    steering: "Potential steering-system concern.",
    electrical_battery: "Potential electrical or battery-system concern.",
    lights: "Potential vehicle-lighting concern.",
    noise_vibration: "Potential component, mounting, or rotating-system concern.",
    other: "Potential vehicle condition requiring WMO review."
  };
  return concerns[category];
}

function evaluateTriage(categoryValue, answerValue) {
  const category = normalizeCategory(categoryValue);
  const answers = normalizeAnswers(answerValue);

  const critical =
    !answers.brakes_safe ||
    !answers.steering_normal ||
    answers.smoke_fire_steam_present ||
    answers.serious_overheating ||
    answers.unsafe_tire ||
    answers.severe_power_loss ||
    answers.movement_safety !== "safe" ||
    answers.lights_affect_safe_visibility;

  if (critical) {
    return {
      ruleset_version: RULESET_VERSION,
      category,
      normalized_answers: answers,
      severity: "critical",
      possible_concern: criticalReason(answers),
      recommended_action:
        "Stop in a safe location when possible, use appropriate warning signals, and contact WMO personnel. Do not continue the operation until authorized personnel assess whether continued movement is safe."
    };
  }

  const moderate =
    answers.warning_indicator_persistent ||
    answers.noise_vibration_recurring ||
    answers.degraded_but_controllable;

  if (moderate) {
    return {
      ruleset_version: RULESET_VERSION,
      category,
      normalized_answers: answers,
      severity: "moderate",
      possible_concern: categoryConcern(category),
      recommended_action:
        "Notify WMO personnel, monitor the condition, and stop safely if it worsens. Request inspection before the next route or sooner if continued operation becomes unsafe."
    };
  }

  return {
    ruleset_version: RULESET_VERSION,
    category,
    normalized_answers: answers,
    severity: "low",
    possible_concern: categoryConcern(category),
    recommended_action:
      "Continue only while the vehicle remains safe and controllable, document any change, and request routine inspection at the next appropriate opportunity."
  };
}

function getAssistantSchema() {
  return {
    ruleset_version: RULESET_VERSION,
    disclaimer:
      "This assistant provides triage guidance only. It does not confirm a mechanical diagnosis or change the truck's Fleet condition.",
    categories: Object.entries(ISSUE_CATEGORIES).map(([value, label]) => ({
      value,
      label
    })),
    questions: QUESTION_SCHEMA.map((question) => ({
      ...question,
      options: question.options ? question.options.map((option) => ({ ...option })) : undefined
    }))
  };
}

module.exports = {
  RULESET_VERSION,
  ISSUE_CATEGORIES,
  QUESTION_SCHEMA,
  VehicleIssueTriageError,
  normalizeCategory,
  normalizeAnswers,
  evaluateTriage,
  getAssistantSchema
};
