const knowledge = require("../data/citizenAssistantKnowledge");

function normalizeCitizenQuestion(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasPhrase(normalized, phrase) {
  const target = normalizeCitizenQuestion(phrase);
  return target && (` ${normalized} `).includes(` ${target} `);
}

function hasAny(normalized, phrases) {
  return phrases.some((phrase) => hasPhrase(normalized, phrase));
}

function detectLanguageStyle(normalized) {
  const scores = Object.fromEntries(Object.entries(knowledge.languageMarkers)
    .map(([language, markers]) => [language, markers.filter((term) => hasPhrase(normalized, term)).length]));
  const local = ["fil", "ceb"].filter((language) => scores[language] > 0);
  if (local.length === 2) return "mixed";
  if (local.length === 1) {
    if (scores.en >= 2 && scores.en >= scores[local[0]]) return local[0] === "fil" ? "taglish" : "bislish";
    return local[0];
  }
  return "en";
}

function findCategory(normalized) {
  // Special-waste safety wins first; negated recyclable terms then beat Recyclable.
  for (const category of ["Special Waste", "Residual", "Biodegradable", "Recyclable"]) {
    if (hasAny(normalized, knowledge.categories[category])) return category;
  }
  return null;
}

function recognizeCitizenQuestion(question) {
  const normalized = normalizeCitizenQuestion(question);
  const languageStyle = detectLanguageStyle(normalized);
  const responseLanguage = languageStyle === "taglish" ? "fil"
    : languageStyle === "bislish" ? "ceb"
      : languageStyle;
  const category = findCategory(normalized);
  const { intents, terms } = knowledge;
  let intent = intents.UNKNOWN;

  if (hasAny(normalized, terms.unsupported)) {
    intent = intents.UNKNOWN;
  } else if (hasAny(normalized, terms.scan) || (hasPhrase(normalized, "scan") && hasAny(normalized, terms.waste))) {
    intent = intents.WASTE_SCAN_HELP;
  } else if (hasAny(normalized, terms.complaint)
    || (hasAny(normalized, terms.report) && hasAny(normalized, terms.waste))) {
    intent = intents.COMPLAINT_HELP;
  } else if (hasAny(normalized, terms.amount)
    && (hasAny(normalized, terms.waste) || hasAny(normalized, terms.barangay) || category)) {
    intent = intents.BARANGAY_WASTE_TOTAL;
  } else if (hasAny(normalized, terms.dispose)
    || hasAny(normalized, ["bin", "lagayan", "category", "klase"])
    || (hasAny(normalized, terms.placement)
      && (hasAny(normalized, terms.waste) || category || hasAny(normalized, knowledge.items)))
    || (category && hasAny(normalized, ["ba", "is this", "what", "unsa", "ano"]))) {
    intent = intents.WASTE_SEGREGATION;
  } else if (hasAny(normalized, terms.general)) {
    intent = intents.GENERAL_HELP;
  }

  return {
    intent,
    languageStyle,
    responseLanguage,
    category,
    requiresValidatedWasteRecords: intent === intents.BARANGAY_WASTE_TOTAL,
    // A total is never synthesized here. Only a separate validated_waste_records query may supply it.
    response: intent === intents.WASTE_SEGREGATION && !category
      && hasAny(normalized, ["plastic bottle", "plastic bottles"])
      && !hasAny(normalized, ["dirty", "contaminated", "marumi", "hugaw"])
      ? knowledge.plasticBottleGuidance[responseLanguage]
      : knowledge.responses[responseLanguage][intent]
  };
}

module.exports = { normalizeCitizenQuestion, detectLanguageStyle, recognizeCitizenQuestion };
