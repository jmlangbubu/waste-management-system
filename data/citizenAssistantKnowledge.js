// Citizen Assistant vocabulary. Keep official category names aligned with utils/wasteMapper.js.
const intents = Object.freeze({
  WASTE_SEGREGATION: "WASTE_SEGREGATION",
  BARANGAY_WASTE_TOTAL: "BARANGAY_WASTE_TOTAL",
  COMPLAINT_HELP: "COMPLAINT_HELP",
  WASTE_SCAN_HELP: "WASTE_SCAN_HELP",
  GENERAL_HELP: "GENERAL_HELP",
  UNKNOWN: "UNKNOWN"
});

const terms = Object.freeze({
  waste: ["waste", "garbage", "trash", "rubbish", "basura", "kalat", "hugaw"],
  amount: ["total", "amount", "overall", "kabuuan", "lahat", "tanan", "pila", "ilang", "kilo", "kg", "how much", "na record", "recorded", "collected"],
  barangay: ["barangay", "brgy"],
  dispose: ["segregate", "segregation", "throw", "dispose", "discard", "itapon", "itatapon", "ilagay", "ilabay", "ibutang", "i segregate", "i dispose"],
  placement: ["where", "saan", "asa", "bin", "lagayan", "category", "klase"],
  complaint: ["complaint", "complaints", "reklamo", "magrereklamo", "concern", "illegal dumping", "tambak na basura"],
  report: ["report", "submit", "maka report", "mo report", "mag report", "magsubmit"],
  scan: ["waste scan", "scan ng basura", "scan sa basura", "scan waste"],
  general: ["what can you do", "what is wmo", "help me", "wmo help", "tulong sa app", "tabang sa app", "how to use this app", "paano gamitin ang app", "unsaon paggamit sa app"],
  unsupported: ["mayor", "phone number", "contact number", "budget", "fee", "ordinance", "penalty", "collection schedule"]
});

const categories = Object.freeze({
  "Biodegradable": ["biodegradable", "nabubulok", "malata", "madaot", "madunot"],
  "Recyclable": ["recyclable", "recycle", "nare recycle", "ma recycle", "pwede i recycle"],
  "Residual": ["residual", "non recyclable", "hindi recyclable", "dili recyclable"],
  "Special Waste": ["special waste", "hazardous", "battery", "batteries", "chemical", "e waste"]
});

const items = ["plastic", "bottle", "bottles", "botelya", "bote", "paper", "food", "item"];

// Function words carry stronger language evidence than shared domain terms such as "waste".
const languageMarkers = Object.freeze({
  en: ["how", "where", "what", "should", "does", "my", "this", "do i", "can i"],
  fil: ["paano", "saan", "ko", "itong", "ito", "namin", "magkano", "ilang", "dapat", "nabubulok"],
  ceb: ["unsaon", "unsay", "unsa", "asa", "nako", "ning", "among", "pila", "tanan", "ug", "aning", "ibutang", "ilabay"]
});

const responses = Object.freeze({
  en: {
    WASTE_SEGREGATION: "Separate biodegradable, recyclable, residual, and special waste. The right bin depends on the item's material and condition; use Waste Scan if unsure.",
    BARANGAY_WASTE_TOTAL: "I can share an official barangay total only when validated waste records are available.",
    COMPLAINT_HELP: "Open Complaints in the app. A report needs a subject, photo, and location; you can add a description. The report is sent for review, not guaranteed immediate resolution.",
    WASTE_SCAN_HELP: "Open Waste Scan to scan an item. Its classification is guidance, not a guarantee; review uncertain results.",
    GENERAL_HELP: "I can help with waste segregation, your barangay's validated waste data, complaint guidance, and Waste Scan.",
    UNKNOWN: "I can help with waste segregation, your barangay's validated waste data, complaint guidance, and Waste Scan. I cannot verify other official information here."
  },
  fil: {
    WASTE_SEGREGATION: "Ihiwalay ang nabubulok, recyclable, residual, at special waste. Depende sa materyal at kondisyon ang tamang lalagyan; gamitin ang Waste Scan kung hindi sigurado.",
    BARANGAY_WASTE_TOTAL: "Maibibigay ko lang ang opisyal na kabuuan ng basura sa barangay kapag may validated waste records.",
    COMPLAINT_HELP: "Buksan ang Complaints sa app. Kailangan ng paksa, larawan, at lokasyon; maaari ring magdagdag ng paglalarawan. Ipapadala ang report para sa review, hindi garantisadong agad maresolba.",
    WASTE_SCAN_HELP: "Buksan ang Waste Scan para i-scan ang bagay. Gabay lamang ang classification; suriin kung hindi malinaw ang resulta.",
    GENERAL_HELP: "Makakatulong ako sa waste segregation, validated waste data ng iyong barangay, complaint guidance, at Waste Scan.",
    UNKNOWN: "Makakatulong ako sa waste segregation, validated waste data ng iyong barangay, complaint guidance, at Waste Scan. Hindi ko ma-verify dito ang ibang opisyal na impormasyon."
  },
  ceb: {
    WASTE_SEGREGATION: "Ilain ang biodegradable, recyclable, residual, ug special waste. Magdepende sa materyal ug kahimtang ang hustong basurahan; gamita ang Waste Scan kung dili sigurado.",
    BARANGAY_WASTE_TOTAL: "Makahatag ra ko og opisyal nga total sa basura sa barangay kung naa nay validated waste records.",
    COMPLAINT_HELP: "Ablihi ang Complaints sa app. Kinahanglan ang subject, hulagway, ug lokasyon; pwede usab magdugang og detalye. Ipadala ang report para sa review, dili garantiya nga masulbad dayon.",
    WASTE_SCAN_HELP: "Ablihi ang Waste Scan aron i-scan ang butang. Giya lang ang classification; susiha kon dili klaro ang resulta.",
    GENERAL_HELP: "Makatabang ko sa waste segregation, validated waste data sa inyong barangay, complaint guidance, ug Waste Scan.",
    UNKNOWN: "Makatabang ko sa waste segregation, validated waste data sa inyong barangay, complaint guidance, ug Waste Scan. Dili nako ma-verify dinhi ang ubang opisyal nga impormasyon."
  },
  mixed: {
    WASTE_SEGREGATION: "I-separate ang biodegradable, recyclable, residual, ug special waste. Depende sa material ug condition ang sakto nga bin; gamita ang Waste Scan kung dili sigurado.",
    BARANGAY_WASTE_TOTAL: "Makapakita lang ko ng official barangay total kung may validated waste records.",
    COMPLAINT_HELP: "Open ang Complaints sa app. Kailangan ang subject, photo, ug location; pwede mag-add ng description. For review ang report.",
    WASTE_SCAN_HELP: "Open ang Waste Scan para i-scan ang item. Guidance lang ang classification; i-check kung unclear ang result.",
    GENERAL_HELP: "Makatabang ako sa waste segregation, validated barangay waste data, complaint guidance, ug Waste Scan.",
    UNKNOWN: "Makatabang ako sa segregation, validated barangay waste data, complaints, ug Waste Scan. Dili ko maghimo-himo ng official information."
  }
});

const noRecords = Object.freeze({
  en: "No validated waste records were found for your barangay.",
  fil: "Walang nahanap na validated waste records para sa iyong barangay.",
  ceb: "Walay nakit-an nga validated waste records para sa inyong barangay.",
  mixed: "Wala pang nakit-an nga validated waste records sa inyong barangay."
});

const unavailableTotals = Object.freeze({
  en: "The validated records do not contain a reliable total for that category.",
  fil: "Walang maaasahang total para sa kategoryang iyon sa validated records.",
  ceb: "Walay kasaligan nga total para sa maong kategoriya sa validated records.",
  mixed: "Walay reliable total para sa maong category sa validated records."
});

const plasticBottleGuidance = Object.freeze({
  en: "A clean, empty plastic bottle can be recyclable. If it is dirty or contaminated, do not assume it belongs with clean recyclables; use Waste Scan for guidance.",
  fil: "Maaaring recyclable ang malinis at walang lamang plastic bottle. Kung marumi ito, huwag ipagpalagay na kasama ito sa malinis na recyclable; gamitin ang Waste Scan bilang gabay.",
  ceb: "Mahimong recyclable ang limpyo ug walay sulod nga plastic bottle. Kung hugaw kini, ayaw dayon isagol sa limpyo nga recyclable; gamita ang Waste Scan isip giya.",
  mixed: "Ang clean, empty plastic bottle mahimong recyclable. Kung hugaw, ayaw isagol sa clean recyclables; gamita ang Waste Scan as guidance."
});

module.exports = { intents, terms, categories, items, languageMarkers, responses, noRecords, unavailableTotals, plasticBottleGuidance };
