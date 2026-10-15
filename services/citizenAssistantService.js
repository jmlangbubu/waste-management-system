const knowledge = require("../data/citizenAssistantKnowledge");
const { recognizeCitizenQuestion } = require("./citizenAssistantLanguageService");

const CATEGORY_COLUMNS = Object.freeze({
  "Biodegradable": ["biodegradable_subtotal", "biodegradableKg"],
  "Recyclable": ["recyclable_subtotal", "recyclableKg"],
  "Residual": ["residual_subtotal", "residualKg"],
  "Special Waste": ["special_subtotal", "specialKg"]
});

class CitizenAssistantError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "CitizenAssistantError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeBarangayKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^(?:barangay|brgy)\s*\.?\s*/, "")
    .replace(/[^a-z0-9]/g, "");
}

function queryReadOnly(connection, sql, parameters = []) {
  return new Promise((resolve, reject) => {
    connection.queryReadOnly(sql, parameters, (error, rows) => {
      if (error) reject(error);
      else resolve(rows || []);
    });
  });
}

function buildWasteAggregateSql(columnSet, strictBarangayScope = false) {
  if (!columnSet.has("barangay_name")) {
    throw new CitizenAssistantError(
      "Validated barangay waste data is unavailable.", 503, "ASSISTANT_BARANGAY_COLUMN_UNAVAILABLE"
    );
  }

  const selections = ["COUNT(*) AS recordCount"];
  const availableCategories = Object.entries(CATEGORY_COLUMNS)
    .filter(([, [column]]) => columnSet.has(column));
  for (const [, [column, alias]] of availableCategories) {
    selections.push(`SUM(COALESCE(${column}, 0)) AS ${alias}`);
  }
  if (columnSet.has("grand_total")) {
    selections.push("SUM(COALESCE(grand_total, 0)) AS totalKg");
  } else if (availableCategories.length === Object.keys(CATEGORY_COLUMNS).length) {
    selections.push(`SUM(${availableCategories.map(([, [column]]) => `COALESCE(${column}, 0)`).join(" + ")}) AS totalKg`);
  }

  // Match only the server-side user's stored barangay, tolerating existing Brgy./Barangay prefixes.
  const barangayKeySql = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    LOWER(TRIM(barangay_name)), 'barangay', ''), 'brgy', ''), '.', ''), '-', ''), ' ', '')`;
  const filters = [`${barangayKeySql} = ?`];
  if (columnSet.has("validation_status")) {
    filters.push("LOWER(TRIM(validation_status)) = 'validated'");
  }
  if (columnSet.has("entry_type")) {
    filters.push(strictBarangayScope
      ? "LOWER(TRIM(entry_type)) = 'barangay'"
      : "(entry_type IS NULL OR LOWER(TRIM(entry_type)) = 'barangay')");
  }
  return `SELECT ${selections.join(", ")} FROM validated_waste_records WHERE ${filters.join(" AND ")}`;
}

function finiteKg(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(2)) : null;
}

function formatTotalAnswer(language, barangay, category, amount) {
  const kg = amount.toFixed(2);
  const subject = category ? `${category} waste` : "waste";
  if (language === "fil") {
    return `Ayon sa lahat ng validated records para sa ${barangay}, ang ${subject} ay ${kg} kg.`;
  }
  if (language === "ceb") {
    return `Sa tanang validated records sa ${barangay}, ang ${subject} kay ${kg} kg.`;
  }
  if (language === "mixed") {
    return `Sa validated records ng ${barangay}, ang ${subject} kay ${kg} kg tanan.`;
  }
  return `Across all validated records for ${barangay}, ${subject} totals ${kg} kg.`;
}

function createCitizenAssistantService(connection = require("../config/db")) {
  async function loadCitizen(userId) {
    const userRows = await queryReadOnly(connection,
      "SELECT id, role, mobile_role, status, barangay FROM users WHERE id = ? LIMIT 1", [userId]);
    const user = userRows[0];
    if (!user) {
      throw new CitizenAssistantError("Citizen account not found.", 404, "ASSISTANT_USER_NOT_FOUND");
    }
    if (String(user.role || user.mobile_role || "").trim().toLowerCase() !== "citizen"
      || String(user.status || "active").trim().toLowerCase() !== "active") {
      throw new CitizenAssistantError("Citizen account is unavailable.", 403, "ASSISTANT_CITIZEN_REQUIRED");
    }
    return user;
  }

  async function loadValidatedTotals(user, strictBarangayScope = false) {
    const barangay = String(user.barangay || "").trim();
    const barangayKey = normalizeBarangayKey(barangay);
    if (!barangayKey) {
      throw new CitizenAssistantError(
        "Citizen barangay is not set.", 422, "ASSISTANT_BARANGAY_REQUIRED"
      );
    }
    const columns = await queryReadOnly(connection, "SHOW COLUMNS FROM validated_waste_records");
    const columnSet = new Set(columns.map((column) => String(column.Field || "").trim()));
    if (strictBarangayScope && ["validation_status", "entry_type", "grand_total",
      ...Object.values(CATEGORY_COLUMNS).map(([column]) => column)]
      .some((column) => !columnSet.has(column))) {
      throw new CitizenAssistantError(
        "Validated barangay waste totals are unavailable.", 503, "DASHBOARD_TOTALS_UNAVAILABLE"
      );
    }
    const sql = buildWasteAggregateSql(columnSet, strictBarangayScope);
    const rows = await queryReadOnly(connection, sql, [barangayKey]);
    const aggregate = rows[0] || {};
    const recordCount = Number(aggregate.recordCount || 0);
    const data = { barangay, recordCount };
    if (recordCount > 0) {
      if (Object.hasOwn(aggregate, "totalKg")) {
        const totalKg = finiteKg(aggregate.totalKg);
        if (totalKg !== null) data.totalKg = totalKg;
      }
      for (const [, [column, alias]] of Object.entries(CATEGORY_COLUMNS)) {
        if (!columnSet.has(column)) continue;
        const value = finiteKg(aggregate[alias]);
        if (value !== null) data[alias] = value;
      }
    }
    return data;
  }

  async function getDashboardSummary({ userId }) {
    const user = await loadCitizen(userId);
    const data = await loadValidatedTotals(user, true);
    const requiredTotals = ["totalKg", ...Object.values(CATEGORY_COLUMNS).map(([, alias]) => alias)];
    if (data.recordCount > 0 && requiredTotals.some((key) => !Object.hasOwn(data, key))) {
      throw new CitizenAssistantError(
        "Validated barangay waste totals are unavailable.", 503, "DASHBOARD_TOTALS_UNAVAILABLE"
      );
    }
    return {
      success: true,
      data: {
        ...data,
        ...Object.fromEntries(requiredTotals
          .filter((key) => !Object.hasOwn(data, key))
          .map((key) => [key, 0]))
      }
    };
  }

  async function ask({ message, userId }) {
    const interpretation = recognizeCitizenQuestion(message);
    const user = await loadCitizen(userId);

    const result = {
      success: true,
      intent: interpretation.intent,
      language: interpretation.responseLanguage,
      languageStyle: interpretation.languageStyle,
      answer: interpretation.response
    };
    if (interpretation.category) result.category = interpretation.category;

    if (!interpretation.requiresValidatedWasteRecords) return result;

    result.data = await loadValidatedTotals(user);
    const { barangay, recordCount } = result.data;

    if (recordCount === 0) {
      result.answer = knowledge.noRecords[result.language];
      return result;
    }
    const requested = interpretation.category
      ? CATEGORY_COLUMNS[interpretation.category]?.[1]
      : "totalKg";
    if (!requested || !Object.hasOwn(result.data, requested)) {
      result.answer = knowledge.unavailableTotals[result.language];
      return result;
    }
    result.answer = formatTotalAnswer(
      result.language, barangay, interpretation.category, result.data[requested]
    );
    return result;
  }

  return { ask, getDashboardSummary };
}

module.exports = {
  CitizenAssistantError,
  createCitizenAssistantService,
  buildWasteAggregateSql,
  normalizeBarangayKey
};
