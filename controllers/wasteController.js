const db = require("../config/dbPromise");

/* =========================================
   WASTE CONTROLLER
   Safe validated waste records persistence
   - Keeps existing API response shape
   - Adds DB column safety checks for signature/notes/raw payload fields
   - Handles older validated_waste_records tables with personnel_name NOT NULL
   - Prevents notification insert failure from blocking validation save
========================================= */

function cleanText(value) {
  if (value === undefined || value === null) return "";

  const text = String(value).trim();

  if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
    return "";
  }

  return text;
}

function safeJsonParse(value) {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "object") return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed);
    } catch (firstError) {
      try {
        const unwrapped = JSON.parse(trimmed);

        if (typeof unwrapped === "string") {
          return JSON.parse(unwrapped);
        }

        return unwrapped;
      } catch (secondError) {
        return null;
      }
    }
  }

  return null;
}

function normalizeRawPayload(rawPayload) {
  if (rawPayload === undefined || rawPayload === null || rawPayload === "") {
    return null;
  }

  if (typeof rawPayload === "object") {
    return JSON.stringify(rawPayload);
  }

  if (typeof rawPayload === "string") {
    const trimmed = rawPayload.trim();

    if (!trimmed) return null;

    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed);
    } catch (firstError) {
      try {
        const unwrapped = JSON.parse(trimmed);

        if (typeof unwrapped === "string") {
          const parsedAgain = JSON.parse(unwrapped);
          return JSON.stringify(parsedAgain);
        }

        return JSON.stringify(unwrapped);
      } catch (secondError) {
        return trimmed;
      }
    }
  }

  return String(rawPayload);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}

function normalizeMysqlDate(value) {
  const cleaned = cleanText(value);

  if (!cleaned) {
    return new Date();
  }

  /*
    Android currently sends "yyyy-MM-dd HH:mm:ss".
    This also accepts ISO dates from future clients.
  */
  const parsed = new Date(cleaned.includes("T") ? cleaned : cleaned.replace(" ", "T"));

  if (!Number.isNaN(parsed.getTime())) {
    return cleaned;
  }

  return new Date();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const cleaned = cleanText(value);

    if (cleaned) return cleaned;
  }

  return "";
}

function formatDateOnly(value) {
  const cleaned = cleanText(value);

  if (!cleaned) {
    return new Date().toISOString().slice(0, 10);
  }

  /*
    Accept:
    - yyyy-MM-dd
    - yyyy-MM-dd HH:mm:ss
    - ISO datetime
  */
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return cleaned;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]/.test(cleaned)) {
    return cleaned.slice(0, 10);
  }

  const parsed = new Date(cleaned);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
}

function formatDateTimeValue(value) {
  const cleaned = cleanText(value);

  if (!cleaned) {
    return new Date();
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cleaned)) {
    return cleaned;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) {
    return cleaned.replace("T", " ").replace(/\.\d{3}Z?$/, "").replace(/Z$/, "");
  }

  const parsed = new Date(cleaned);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 19).replace("T", " ");
  }

  return new Date();
}

function getDateFallbackFromBody(body = {}) {
  const rawPayloadObject = safeJsonParse(body.raw_payload);
  const nestedRawPayload = rawPayloadObject && typeof rawPayloadObject === "object"
    ? rawPayloadObject
    : {};

  return formatDateOnly(
    firstNonEmpty(
      body.collection_date,
      body.collectionDate,
      body.date,
      body.record_date,
      body.submitted_at,
      body.validated_at,
      body.period_from,
      nestedRawPayload.collection_date,
      nestedRawPayload.collectionDate,
      nestedRawPayload.date,
      nestedRawPayload.recordDate,
      nestedRawPayload.submittedAt,
      nestedRawPayload.validatedAt,
      nestedRawPayload.periodFrom,
      nestedRawPayload.period_from
    )
  );
}

async function getTableColumns(tableName) {
  const safeTableName = String(tableName || "").replace(/[^a-zA-Z0-9_]/g, "");

  if (!safeTableName) {
    throw new Error("Invalid table name.");
  }

  const [rows] = await db.query(`SHOW COLUMNS FROM ${safeTableName}`);

  return rows || [];
}

async function getTableColumnSet(tableName) {
  const rows = await getTableColumns(tableName);

  return new Set(
    rows.map((row) => String(row.Field || "").trim())
  );
}

function hasColumn(columnSet, columnName) {
  return columnSet && columnSet.has(columnName);
}

function getColumnMetaMap(rows = []) {
  const map = new Map();

  rows.forEach((row) => {
    const field = cleanText(row.Field);

    if (field) {
      map.set(field, row);
    }
  });

  return map;
}

async function runAlterTableSafely(sql, label) {
  try {
    await db.query(sql);
    console.log(`[DB] ${label}`);
  } catch (error) {
    /*
      Duplicate column can happen if two requests run the column check at the same time.
      Do not crash the validation flow because of a harmless duplicate-column race.
    */
    if (error && error.code === "ER_DUP_FIELDNAME") {
      console.warn(`[DB] ${label} skipped because column already exists.`);
      return;
    }

    throw error;
  }
}

async function ensureValidatedWasteRecordColumns() {
  let columnSet = await getTableColumnSet("validated_waste_records");
  const alters = [];

  /*
    These columns are used by the Android enforcer validation flow.
    Use LONGTEXT for enforcer_signature because base64 PNG signatures can be large.
  */
  if (!hasColumn(columnSet, "entry_type")) {
    alters.push("ADD COLUMN entry_type VARCHAR(80) NULL");
  }

  if (!hasColumn(columnSet, "barangay_name")) {
    alters.push("ADD COLUMN barangay_name VARCHAR(255) NULL");
  }

  if (!hasColumn(columnSet, "establishment_name")) {
    alters.push("ADD COLUMN establishment_name VARCHAR(255) NULL");
  }

  if (!hasColumn(columnSet, "barangay_address")) {
    alters.push("ADD COLUMN barangay_address VARCHAR(255) NULL");
  }

  if (!hasColumn(columnSet, "establishment_address")) {
    alters.push("ADD COLUMN establishment_address VARCHAR(255) NULL");
  }

  if (!hasColumn(columnSet, "source_type")) {
    alters.push("ADD COLUMN source_type VARCHAR(120) NULL");
  }

  /*
    Some older validated_waste_records tables already have personnel_name as NOT NULL.
    Android validation sends validated_by as the enforcer name, so the insert must
    provide personnel_name too when the column exists.
  */
  if (!hasColumn(columnSet, "personnel_name")) {
    alters.push("ADD COLUMN personnel_name VARCHAR(255) NULL");
  }

  if (!hasColumn(columnSet, "collection_date")) {
    alters.push("ADD COLUMN collection_date DATE NULL");
  }

  if (!hasColumn(columnSet, "period_from")) {
    alters.push("ADD COLUMN period_from DATE NULL");
  }

  if (!hasColumn(columnSet, "period_to")) {
    alters.push("ADD COLUMN period_to DATE NULL");
  }

  if (!hasColumn(columnSet, "remarks")) {
    alters.push("ADD COLUMN remarks TEXT NULL");
  }

  if (!hasColumn(columnSet, "biodegradable_subtotal")) {
    alters.push("ADD COLUMN biodegradable_subtotal DECIMAL(12,2) NOT NULL DEFAULT 0");
  }

  if (!hasColumn(columnSet, "recyclable_subtotal")) {
    alters.push("ADD COLUMN recyclable_subtotal DECIMAL(12,2) NOT NULL DEFAULT 0");
  }

  if (!hasColumn(columnSet, "residual_subtotal")) {
    alters.push("ADD COLUMN residual_subtotal DECIMAL(12,2) NOT NULL DEFAULT 0");
  }

  if (!hasColumn(columnSet, "special_subtotal")) {
    alters.push("ADD COLUMN special_subtotal DECIMAL(12,2) NOT NULL DEFAULT 0");
  }

  if (!hasColumn(columnSet, "grand_total")) {
    alters.push("ADD COLUMN grand_total DECIMAL(12,2) NOT NULL DEFAULT 0");
  }

  if (!hasColumn(columnSet, "validation_status")) {
    alters.push("ADD COLUMN validation_status VARCHAR(80) NOT NULL DEFAULT 'Validated'");
  }

  if (!hasColumn(columnSet, "validated_by")) {
    alters.push("ADD COLUMN validated_by VARCHAR(255) NULL");
  }

  if (!hasColumn(columnSet, "enforcer_signature")) {
    alters.push("ADD COLUMN enforcer_signature LONGTEXT NULL");
  }

  if (!hasColumn(columnSet, "validated_at")) {
    alters.push("ADD COLUMN validated_at DATETIME NULL");
  }

  if (!hasColumn(columnSet, "validation_notes")) {
    alters.push("ADD COLUMN validation_notes TEXT NULL");
  }

  if (!hasColumn(columnSet, "raw_payload")) {
    alters.push("ADD COLUMN raw_payload LONGTEXT NULL");
  }

  if (!hasColumn(columnSet, "created_at")) {
    alters.push("ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
  }

  if (alters.length > 0) {
    await runAlterTableSafely(
      `
        ALTER TABLE validated_waste_records
        ${alters.join(",\n        ")}
      `,
      "validated_waste_records optional columns checked/added."
    );

    columnSet = await getTableColumnSet("validated_waste_records");
  }

  return columnSet;
}

async function ensureNotificationsTableSafe() {
  /*
    Existing WMO notification UI reads from notifications in some parts of the web
    admin. Keep this safe so waste validation does not fail if notification schema
    is incomplete.
  */
  await db.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(100) NULL,
      title VARCHAR(255) NULL,
      message TEXT NULL,
      createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  let columnSet = await getTableColumnSet("notifications");
  const alters = [];

  if (!hasColumn(columnSet, "type")) {
    alters.push("ADD COLUMN type VARCHAR(100) NULL");
  }

  if (!hasColumn(columnSet, "title")) {
    alters.push("ADD COLUMN title VARCHAR(255) NULL");
  }

  if (!hasColumn(columnSet, "message")) {
    alters.push("ADD COLUMN message TEXT NULL");
  }

  if (!hasColumn(columnSet, "createdAt")) {
    alters.push("ADD COLUMN createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP");
  }

  if (alters.length > 0) {
    await runAlterTableSafely(
      `
        ALTER TABLE notifications
        ${alters.join(",\n        ")}
      `,
      "notifications optional columns checked/added."
    );

    columnSet = await getTableColumnSet("notifications");
  }

  return columnSet;
}

async function createWmoWasteNotification(sourceName) {
  try {
    await ensureNotificationsTableSafe();

    await db.query(
      `
        INSERT INTO notifications (type, title, message)
        VALUES (?, ?, ?)
      `,
      [
        "waste_report",
        "New Validated Waste Record",
        `${sourceName || "Unknown source"} • Validated waste submission`
      ]
    );
  } catch (error) {
    /*
      Notification failure should not block the validated waste record.
      The main data save is more important for the Android enforcer flow.
    */
    console.error("createWmoWasteNotification warning:", error);
  }
}

function getPersonnelNameFromBody(body = {}) {
  const rawPayloadObject = safeJsonParse(body.raw_payload);
  const nestedRawPayload = rawPayloadObject && typeof rawPayloadObject === "object"
    ? rawPayloadObject
    : {};

  return firstNonEmpty(
    body.personnel_name,
    body.personnelName,
    body.submitted_by,
    body.submittedBy,
    body.created_by,
    body.createdBy,
    nestedRawPayload.personnel_name,
    nestedRawPayload.personnelName,
    nestedRawPayload.submitted_by,
    nestedRawPayload.submittedBy,
    nestedRawPayload.created_by,
    nestedRawPayload.createdBy,
    body.validated_by,
    "Unknown Personnel"
  );
}

function getFallbackValueForRequiredColumn(columnName, body = {}) {
  const rawPayloadObject = safeJsonParse(body.raw_payload);
  const nestedRawPayload = rawPayloadObject && typeof rawPayloadObject === "object"
    ? rawPayloadObject
    : {};

  switch (columnName) {
    case "personnel_name":
      return getPersonnelNameFromBody(body);

    case "entry_type":
      return cleanText(body.entry_type) || "barangay";

    case "barangay_name":
      return firstNonEmpty(body.barangay_name, nestedRawPayload.barangayName, nestedRawPayload.barangay_name, "N/A");

    case "establishment_name":
      return firstNonEmpty(body.establishment_name, nestedRawPayload.establishmentName, nestedRawPayload.establishment_name, "N/A");

    case "collection_date":
    case "date":
    case "record_date":
      return getDateFallbackFromBody(body);

    case "period_from":
      return formatDateOnly(firstNonEmpty(body.period_from, nestedRawPayload.periodFrom, nestedRawPayload.period_from));

    case "period_to":
      return formatDateOnly(firstNonEmpty(body.period_to, nestedRawPayload.periodTo, nestedRawPayload.period_to, body.period_from, nestedRawPayload.periodFrom, nestedRawPayload.period_from));

    case "remarks":
    case "validation_notes":
      return "N/A";

    case "raw_payload":
      return normalizeRawPayload(body.raw_payload) || "{}";

    case "enforcer_signature":
      return "N/A";

    case "biodegradable_subtotal":
    case "recyclable_subtotal":
    case "residual_subtotal":
    case "special_subtotal":
    case "grand_total":
      return 0;

    case "validation_status":
      return "Validated";

    case "validated_by":
      return firstNonEmpty(body.validated_by, "Unknown Enforcer");

    case "validated_at":
      return new Date();

    default: {
      const metaValue = cleanText(body[columnName]);

      if (metaValue) {
        return metaValue;
      }

      /*
        Do not return an empty string for required DATE/DATETIME columns.
        MySQL strict mode rejects '' for DATE fields, which caused:
        ER_TRUNCATED_WRONG_VALUE: Incorrect date value: '' for column 'collection_date'
      */
      if (columnName.toLowerCase().includes("date")) {
        return getDateFallbackFromBody(body);
      }

      if (
        columnName.toLowerCase().includes("time") ||
        columnName.toLowerCase().includes("_at")
      ) {
        return formatDateTimeValue(body.validated_at);
      }

      return "N/A";
    }
  }
}

/*
  Some legacy table columns may be NOT NULL with no default.
  This function prevents ER_NO_DEFAULT_FOR_FIELD by adding safe fallback values
  for any required column that the dynamic insert did not already include.
*/
async function addRequiredNoDefaultColumns(insertColumns, insertValues, body = {}) {
  const rows = await getTableColumns("validated_waste_records");
  const columnMetaMap = getColumnMetaMap(rows);
  const existing = new Set(insertColumns);

  columnMetaMap.forEach((meta, columnName) => {
    const isAutoIncrement = cleanText(meta.Extra).toLowerCase().includes("auto_increment");
    const canBeNull = String(meta.Null || "").toUpperCase() === "YES";
    const hasDefault = meta.Default !== null && meta.Default !== undefined;

    if (existing.has(columnName) || isAutoIncrement || canBeNull || hasDefault) {
      return;
    }

    insertColumns.push(columnName);
    insertValues.push(getFallbackValueForRequiredColumn(columnName, body));
    existing.add(columnName);
  });
}

/* =========================================
   CREATE VALIDATED WASTE RECORD
========================================= */
const createValidatedWasteRecord = async (req, res) => {
  try {
    const body = req.body || {};

    const {
      entry_type,
      barangay_name,
      establishment_name,
      barangay_address,
      establishment_address,
      source_type,
      period_from,
      period_to,
      remarks,
      biodegradable_subtotal,
      recyclable_subtotal,
      residual_subtotal,
      special_subtotal,
      grand_total,
      validation_status,
      validated_by,
      enforcer_signature,
      validated_at,
      validation_notes,
      raw_payload
    } = body;

    const sourceName = cleanText(barangay_name || establishment_name);

    if (!sourceName) {
      return res.status(400).json({
        success: false,
        message: "Barangay name or establishment name is required."
      });
    }

    const normalizedRawPayload = normalizeRawPayload(raw_payload);
    const columnSet = await ensureValidatedWasteRecordColumns();
    const personnelName = getPersonnelNameFromBody(body);

    /*
      Dynamic insert:
      Only inserts columns that exist in the current database.
      This prevents 500 errors on older databases while still saving new fields
      after ensureValidatedWasteRecordColumns adds them.
    */
    const insertColumns = [];
    const insertValues = [];

    function addColumn(columnName, value) {
      if (!hasColumn(columnSet, columnName)) return;

      insertColumns.push(columnName);
      insertValues.push(value);
    }

    addColumn("entry_type", cleanText(entry_type) || null);
    addColumn("barangay_name", cleanText(barangay_name) || null);
    addColumn("establishment_name", cleanText(establishment_name) || null);
    addColumn("barangay_address", cleanText(barangay_address) || null);
    addColumn("establishment_address", cleanText(establishment_address) || null);
    addColumn("source_type", cleanText(source_type) || null);
    addColumn("personnel_name", personnelName);
    addColumn("collection_date", getDateFallbackFromBody(body));
    addColumn("period_from", cleanText(period_from) || null);
    addColumn("period_to", cleanText(period_to) || null);
    addColumn("remarks", cleanText(remarks) || null);
    addColumn("biodegradable_subtotal", toNumber(biodegradable_subtotal));
    addColumn("recyclable_subtotal", toNumber(recyclable_subtotal));
    addColumn("residual_subtotal", toNumber(residual_subtotal));
    addColumn("special_subtotal", toNumber(special_subtotal));
    addColumn("grand_total", toNumber(grand_total));
    addColumn("validation_status", cleanText(validation_status) || "Validated");
    addColumn("validated_by", cleanText(validated_by) || null);
    addColumn("enforcer_signature", cleanText(enforcer_signature) || null);
    addColumn("validated_at", normalizeMysqlDate(validated_at));
    addColumn("validation_notes", cleanText(validation_notes) || null);
    addColumn("raw_payload", normalizedRawPayload);

    await addRequiredNoDefaultColumns(insertColumns, insertValues, body);

    if (!insertColumns.length) {
      return res.status(500).json({
        success: false,
        message: "Validated waste record table has no compatible columns."
      });
    }

    const placeholders = insertColumns.map(() => "?").join(", ");

    const [result] = await db.query(
      `
        INSERT INTO validated_waste_records (
          ${insertColumns.join(",\n          ")}
        )
        VALUES (${placeholders})
      `,
      insertValues
    );

    await createWmoWasteNotification(sourceName);

    return res.status(201).json({
      success: true,
      message: "Validated waste record saved successfully.",
      insertedId: result.insertId
    });
  } catch (error) {
    console.error("createValidatedWasteRecord error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
      code: error.code || null
    });
  }
};

/* =========================================
   GET VALIDATED WASTE RECORDS
========================================= */
const getValidatedWasteRecords = async (req, res) => {
  try {
    const columnSet = await ensureValidatedWasteRecordColumns();

    const preferredFields = [
      "id",
      "entry_type",
      "barangay_name",
      "establishment_name",
      "barangay_address",
      "establishment_address",
      "source_type",
      "personnel_name",
      "collection_date",
      "period_from",
      "period_to",
      "remarks",
      "biodegradable_subtotal",
      "recyclable_subtotal",
      "residual_subtotal",
      "special_subtotal",
      "grand_total",
      "validation_status",
      "validated_by",
      "enforcer_signature",
      "validated_at",
      "validation_notes",
      "raw_payload",
      "created_at"
    ];

    const fields = preferredFields.filter((field) => hasColumn(columnSet, field));

    const orderColumn = hasColumn(columnSet, "validated_at")
      ? "validated_at"
      : hasColumn(columnSet, "created_at")
        ? "created_at"
        : "id";

    const [results] = await db.query(
      `
        SELECT
          ${fields.join(",\n          ")}
        FROM validated_waste_records
        ORDER BY ${orderColumn} DESC, id DESC
      `
    );

    return res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("getValidatedWasteRecords error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch validated waste records.",
      error: error.message,
      code: error.code || null
    });
  }
};

module.exports = {
  createValidatedWasteRecord,
  getValidatedWasteRecords
};
