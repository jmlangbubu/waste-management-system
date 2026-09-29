const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeCitizenQuestion,
  recognizeCitizenQuestion
} = require("../services/citizenAssistantLanguageService");

test("normalization tolerates case, punctuation, hyphens, and spacing", () => {
  assert.equal(normalizeCitizenQuestion("  SAAN  ko i-segregate... itong PLASTIC?  "),
    "saan ko i segregate itong plastic");
});

const examples = [
  ["How much waste has my barangay recorded?", "BARANGAY_WASTE_TOTAL", "en", "en"],
  ["Ilang kilo na ang basura sa barangay namin?", "BARANGAY_WASTE_TOTAL", "fil", "fil"],
  ["Pila na ka kilo ang basura sa among barangay?", "BARANGAY_WASTE_TOTAL", "ceb", "ceb"],
  ["Pila ang total recyclable waste sa barangay namin?", "BARANGAY_WASTE_TOTAL", "mixed", "mixed"],
  ["How do I segregate plastic bottles?", "WASTE_SEGREGATION", "en", "en"],
  ["Saan ko itatapon ang plastic bottle?", "WASTE_SEGREGATION", "fil", "fil"],
  ["Asa nako ibutang ang plastic bottle?", "WASTE_SEGREGATION", "ceb", "ceb"],
  ["Paano mag report ng complaint?", "COMPLAINT_HELP", "fil", "fil"],
  ["Unsaon pag report ug complaint?", "COMPLAINT_HELP", "ceb", "ceb"],
  ["How do I use Waste Scan?", "WASTE_SCAN_HELP", "en", "en"],
  ["Paano gamitin ang Waste Scan?", "WASTE_SCAN_HELP", "fil", "fil"],
  ["Unsaon paggamit sa Waste Scan?", "WASTE_SCAN_HELP", "ceb", "ceb"]
];

for (const [question, intent, languageStyle, responseLanguage] of examples) {
  test(`${question} -> ${intent}, ${languageStyle}, ${responseLanguage}`, () => {
    const result = recognizeCitizenQuestion(question);
    assert.equal(result.intent, intent);
    assert.equal(result.languageStyle, languageStyle);
    assert.equal(result.responseLanguage, responseLanguage);
    assert.ok(result.response);
  });
}

test("synonyms and mixed sentences resolve without exact full-sentence matching", () => {
  assert.equal(recognizeCitizenQuestion("Asa nako i-dispose ning recyclable?").intent,
    "WASTE_SEGREGATION");
  assert.equal(recognizeCitizenQuestion("Paano mag scan ng basura?").intent,
    "WASTE_SCAN_HELP");
  assert.equal(recognizeCitizenQuestion("Asa ko mo report aning basura?").intent,
    "COMPLAINT_HELP");
  assert.equal(recognizeCitizenQuestion("Unsay total waste sa barangay?").languageStyle,
    "ceb");
});

test("Taglish and Bislish functional wording selects the local response language", () => {
  const taglish = recognizeCitizenQuestion("How should ko itapon itong plastic?");
  assert.equal(taglish.intent, "WASTE_SEGREGATION");
  assert.equal(taglish.languageStyle, "taglish");
  assert.equal(taglish.responseLanguage, "fil");

  const bislish = recognizeCitizenQuestion("How should nako ibutang ang plastic?");
  assert.equal(bislish.intent, "WASTE_SEGREGATION");
  assert.equal(bislish.languageStyle, "bislish");
  assert.equal(bislish.responseLanguage, "ceb");
});

test("official totals require validated records and never fabricate a number", () => {
  const result = recognizeCitizenQuestion("Pila ang total recyclable waste sa barangay namin?");
  assert.equal(result.category, "Recyclable");
  assert.equal(result.requiresValidatedWasteRecords, true);
  assert.doesNotMatch(result.response, /\d/);
});

test("repository category labels and negative recyclable wording are preserved", () => {
  assert.equal(recognizeCitizenQuestion("Saan ilagay ang nabubulok?").category,
    "Biodegradable");
  assert.equal(recognizeCitizenQuestion("Dili recyclable ni?").category,
    "Residual");
  assert.equal(recognizeCitizenQuestion("Where should hazardous waste go?").category,
    "Special Waste");
  assert.equal(recognizeCitizenQuestion("Hazardous, non-recyclable item").category,
    "Special Waste");
});

test("unrecognized requests do not receive made-up facts", () => {
  const result = recognizeCitizenQuestion("What is the weather tomorrow?");
  assert.equal(result.intent, "UNKNOWN");
  assert.equal(result.requiresValidatedWasteRecords, false);
});
