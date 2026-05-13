const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const db = require("../config/db");
const { analyzeWaste } = require("../services/wasteAnalysisService");
const wasteController = require("../controllers/wasteController");

/* =========================================
   SCAN IMAGE STORAGE HELPERS
   - Saves the base64 image sent by the Android scanner.
   - Stores the public URL in scan_history.image_url.
   - /uploads is already served by server.js.
========================================= */
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const WASTE_SCAN_UPLOADS_DIR = path.join(UPLOADS_DIR, "waste-scans");

if (!fs.existsSync(WASTE_SCAN_UPLOADS_DIR)) {
  fs.mkdirSync(WASTE_SCAN_UPLOADS_DIR, { recursive: true });
}

function cleanText(value) {
  if (value === null || value === undefined) return "";

  const text = String(value).trim();

  if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "undefined") {
    return "";
  }

  return text;
}

function getScanHistoryColumnSet(callback) {
  const sql = `SHOW COLUMNS FROM scan_history`;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("[DB] Failed to inspect scan_history columns:", err);
      return callback(err, new Set());
    }

    const columnSet = new Set(
      (rows || []).map((row) => String(row.Field || "").trim())
    );

    return callback(null, columnSet);
  });
}

function hasColumn(columnSet, columnName) {
  return columnSet && columnSet.has(columnName);
}

function getTableColumnSet(tableName, callback) {
  const safeTableName = String(tableName || "").replace(/[^a-zA-Z0-9_]/g, "");

  if (!safeTableName) {
    return callback(new Error("Invalid table name"), new Set());
  }

  db.query(`SHOW COLUMNS FROM ${safeTableName}`, (err, rows) => {
    if (err) {
      console.error(`[DB] Failed to inspect ${safeTableName} columns:`, err);
      return callback(err, new Set());
    }

    const columnSet = new Set(
      (rows || []).map((row) => String(row.Field || "").trim())
    );

    return callback(null, columnSet);
  });
}

function getCurrentMonthDateFilter(columnSet) {
  /*
    Citizen dashboard analytics must reset every month.
    We do not delete old records; we only filter the dashboard total
    to records within the current month.

    Priority:
    1. validated_at / validation_date / date_validated = best audit date
    2. created_at / submitted_at = fallback if validation date is not present
    3. period_from = last fallback for older table structures
  */
  const candidateColumns = [
    "validated_at",
    "validation_date",
    "date_validated",
    "validated_date",
    "created_at",
    "submitted_at",
    "period_from"
  ];

  for (const columnName of candidateColumns) {
    if (hasColumn(columnSet, columnName)) {
      return {
        columnName,
        sql: `
          AND ${columnName} >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND ${columnName} < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
        `
      };
    }
  }

  return {
    columnName: "",
    sql: ""
  };
}

function getCurrentYearDateFilter(columnSet) {
  /*
    Monthly modal must reset every year.
    This returns only records from January 1 to December 31 of the current year.
    Old records stay in the database for reports/history.
  */
  const candidateColumns = [
    "validated_at",
    "validation_date",
    "date_validated",
    "validated_date",
    "created_at",
    "submitted_at",
    "period_from"
  ];

  for (const columnName of candidateColumns) {
    if (hasColumn(columnSet, columnName)) {
      return {
        columnName,
        sql: `
          AND ${columnName} >= MAKEDATE(YEAR(CURDATE()), 1)
          AND ${columnName} < MAKEDATE(YEAR(CURDATE()) + 1, 1)
        `
      };
    }
  }

  return {
    columnName: "",
    sql: ""
  };
}

function getMonthName(monthNumber) {
  const names = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];

  return names[Number(monthNumber)] || "Unknown";
}

function buildMonthlyAssistantComment(total, biodegradable, recyclable, residual, special) {
  const numericTotal = Number(total || 0);

  if (numericTotal <= 0) {
    return "No validated waste data is recorded for this month yet.";
  }

  const values = [
    { key: "Biodegradable", value: Number(biodegradable || 0), tip: "Composting and proper food waste segregation should continue." },
    { key: "Recyclable", value: Number(recyclable || 0), tip: "Keep recyclable materials clean and separated before collection." },
    { key: "Residual", value: Number(residual || 0), tip: "Residual waste is high, so reduce single-use packaging when possible." },
    { key: "Special Waste", value: Number(special || 0), tip: "Special waste needs safe handling and should not be mixed with regular waste." }
  ];

  values.sort((a, b) => b.value - a.value);

  const top = values[0];
  const percent = numericTotal > 0 ? Math.round((top.value / numericTotal) * 100) : 0;

  return `${top.key} has the highest share this month at ${percent}%. ${top.tip}`;
}

function ensureScanHistoryOptionalColumns(callback) {
  getScanHistoryColumnSet((columnErr, columnSet) => {
    if (columnErr) {
      return callback(columnErr, columnSet || new Set());
    }

    const alters = [];

    if (!hasColumn(columnSet, "image_url")) {
      alters.push("ADD COLUMN image_url VARCHAR(500) NULL");
    }

    if (!hasColumn(columnSet, "analysis_source")) {
      alters.push("ADD COLUMN analysis_source VARCHAR(120) NULL");
    }

    if (!hasColumn(columnSet, "ai_label")) {
      alters.push("ADD COLUMN ai_label VARCHAR(255) NULL");
    }

    if (!hasColumn(columnSet, "ai_confidence")) {
      alters.push("ADD COLUMN ai_confidence VARCHAR(50) NULL");
    }

    if (alters.length === 0) {
      return callback(null, columnSet);
    }

    const alterSql = `
      ALTER TABLE scan_history
      ${alters.join(",\n      ")}
    `;

    db.query(alterSql, (alterErr) => {
      if (alterErr) {
        console.error("[DB] Failed to add optional scan_history columns:", alterErr);
        console.error("[DB] The API will continue, but captured image URLs may not be saved until columns are added.");
        return callback(null, columnSet);
      }

      return getScanHistoryColumnSet(callback);
    });
  });
}

ensureScanHistoryOptionalColumns((err) => {
  if (err) {
    console.error("[DB] scan_history optional column check failed:", err.message);
  } else {
    console.log("[DB] scan_history optional columns ready.");
  }
});

function getBase64Payload(image) {
  const raw = cleanText(image);

  if (!raw) return "";

  const commaIndex = raw.indexOf(",");

  if (raw.startsWith("data:image/") && commaIndex !== -1) {
    return raw.substring(commaIndex + 1);
  }

  return raw;
}

function inferImageExtension(buffer, rawImage) {
  const raw = cleanText(rawImage).toLowerCase();

  if (raw.startsWith("data:image/png")) return "png";
  if (raw.startsWith("data:image/webp")) return "webp";
  if (raw.startsWith("data:image/jpeg") || raw.startsWith("data:image/jpg")) return "jpg";

  if (buffer && buffer.length >= 12) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46
    ) {
      return "webp";
    }
  }

  return "jpg";
}

function saveScanImageFromBase64(image) {
  try {
    const payload = getBase64Payload(image);

    if (!payload) {
      return null;
    }

    const buffer = Buffer.from(payload, "base64");

    if (!buffer || buffer.length <= 0) {
      return null;
    }

    const ext = inferImageExtension(buffer, image);
    const fileName = `scan_${Date.now()}_${Math.round(Math.random() * 1000000000)}.${ext}`;
    const filePath = path.join(WASTE_SCAN_UPLOADS_DIR, fileName);

    fs.writeFileSync(filePath, buffer);

    return {
      fileName,
      filePath,
      imageUrl: `/uploads/waste-scans/${fileName}`,
      sizeBytes: buffer.length
    };
  } catch (err) {
    console.error("[UPLOAD] Failed to save scan image:", err);
    return null;
  }
}

function getFirstAvailableString(row, keys) {
  for (const key of keys) {
    const value = cleanText(row ? row[key] : "");

    if (value) {
      return value;
    }
  }

  return "";
}

function buildEmergencyResult(detectedObject = "", mlKitLabels = []) {
  const objectText = String(detectedObject || "").toLowerCase();

  const labelsText = Array.isArray(mlKitLabels)
    ? mlKitLabels
        .map((label) => {
          if (typeof label === "string") return label.toLowerCase();
          return String(label?.description || label?.name || "").toLowerCase();
        })
        .join(" ")
    : "";

  const combinedText = `${objectText} ${labelsText}`.trim();

  let category = "Residual";
  let explanation =
    "The system could not confidently identify the waste item, so it was classified as residual as a safe fallback.";
  let action =
    "Place the item in the residual waste bin. Avoid mixing it with recyclable or special waste items.";
  let warning =
    "This is a fallback result used when the item is unclear or the AI analysis is unstable.";

  if (
    combinedText.includes("bottle") ||
    combinedText.includes("plastic") ||
    combinedText.includes("can") ||
    combinedText.includes("glass") ||
    combinedText.includes("paper") ||
    combinedText.includes("carton") ||
    combinedText.includes("cardboard") ||
    combinedText.includes("container")
  ) {
    category = "Recyclable";
    explanation =
      "This item appears recyclable based on the detected object or labels.";
    action =
      "Place the item in the recyclable waste bin. Clean it first if possible.";
    warning =
      "Items contaminated with food or chemicals may no longer be suitable for recycling.";
  } else if (
    combinedText.includes("battery") ||
    combinedText.includes("charger") ||
    combinedText.includes("adapter") ||
    combinedText.includes("bulb") ||
    combinedText.includes("electronic") ||
    combinedText.includes("electronics") ||
    combinedText.includes("wire") ||
    combinedText.includes("cable") ||
    combinedText.includes("medicine") ||
    combinedText.includes("chemical") ||
    combinedText.includes("spray") ||
    combinedText.includes("aerosol")
  ) {
    category = "Special Waste";
    explanation =
      "This item appears to require special handling based on the detected object or labels.";
    action =
      "Do not mix this item with ordinary waste. Bring it to the proper special waste collection point.";
    warning =
      "Improper disposal of special waste may harm people and the environment.";
  }

  return {
    itemName: category,
    category,
    explanation,
    action,
    warning,
    detectedObject: detectedObject || category,
    aiLabel: detectedObject || null,
    aiConfidence: null,
    analysisSource: "emergency_stable_mode"
  };
}

/* =========================================
   VALIDATED WASTE RECORDS (NEW SYSTEM)
========================================= */
router.get("/validated-records", wasteController.getValidatedWasteRecords);
router.post("/validated-records", wasteController.createValidatedWasteRecord);

/* =========================================
   BARANGAY ANALYTICS FOR CITIZEN DASHBOARD
========================================= */
router.get("/analytics/barangay", (req, res) => {
  const barangay = req.query ? String(req.query.barangay || "").trim() : "";

  if (!barangay) {
    return res.status(400).json({
      success: false,
      message: "Barangay is required"
    });
  }

  getTableColumnSet("validated_waste_records", (columnErr, columnSet) => {
    if (columnErr) {
      console.error("[DB] Failed to inspect validated_waste_records columns:", columnErr);
      return res.status(500).json({
        success: false,
        message: "Failed to inspect waste analytics table",
        error: columnErr.message
      });
    }

    const monthFilter = getCurrentMonthDateFilter(columnSet);

    const sql = `
      SELECT
        COALESCE(SUM(CAST(biodegradable_subtotal AS DECIMAL(12,2))), 0) AS biodegradable,
        COALESCE(SUM(CAST(recyclable_subtotal AS DECIMAL(12,2))), 0) AS recyclable,
        COALESCE(SUM(CAST(residual_subtotal AS DECIMAL(12,2))), 0) AS residual,
        COALESCE(SUM(CAST(special_subtotal AS DECIMAL(12,2))), 0) AS special,
        COALESCE(SUM(CAST(grand_total AS DECIMAL(12,2))), 0) AS total_records_waste,
        COUNT(*) AS total_records
      FROM validated_waste_records
      WHERE LOWER(TRIM(barangay_name)) = LOWER(TRIM(?))
        AND LOWER(TRIM(validation_status)) = 'validated'
        ${monthFilter.sql}
    `;

    db.query(sql, [barangay], (err, results) => {
      if (err) {
        console.error("[DB] Failed to load barangay analytics:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load barangay analytics",
          error: err.message
        });
      }

      const row = Array.isArray(results) && results.length > 0 ? results[0] : {};

      return res.json({
        success: true,
        data: {
          barangay,
          scope: "current_month",
          month: new Date().toISOString().slice(0, 7),
          date_column_used: monthFilter.columnName || null,
          biodegradable: Number(row.biodegradable || 0),
          recyclable: Number(row.recyclable || 0),
          residual: Number(row.residual || 0),
          special: Number(row.special || 0),
          total: Number(row.total_records_waste || 0),
          total_records: Number(row.total_records || 0)
        }
      });
    });
  });
});


/* =========================================
   BARANGAY MONTHLY ANALYTICS FOR CITIZEN MODAL
   - Current year only
   - Resets visually every year without deleting old records
========================================= */
router.get("/analytics/barangay/monthly", (req, res) => {
  const barangay = req.query ? String(req.query.barangay || "").trim() : "";

  if (!barangay) {
    return res.status(400).json({
      success: false,
      message: "Barangay is required"
    });
  }

  getTableColumnSet("validated_waste_records", (columnErr, columnSet) => {
    if (columnErr) {
      console.error("[DB] Failed to inspect validated_waste_records columns:", columnErr);
      return res.status(500).json({
        success: false,
        message: "Failed to inspect waste analytics table",
        error: columnErr.message
      });
    }

    const yearFilter = getCurrentYearDateFilter(columnSet);

    if (!yearFilter.columnName) {
      return res.json({
        success: true,
        data: {
          barangay,
          scope: "current_year",
          year: new Date().getFullYear(),
          date_column_used: null,
          grand_total: 0,
          total_records: 0,
          months: Array.from({ length: 12 }, (_, index) => ({
            month: index + 1,
            month_name: getMonthName(index + 1),
            biodegradable: 0,
            recyclable: 0,
            residual: 0,
            special: 0,
            total: 0,
            total_records: 0,
            assistant_comment: "No validated waste data is recorded for this month yet."
          }))
        }
      });
    }

    const sql = `
      SELECT
        MONTH(${yearFilter.columnName}) AS month_number,
        COALESCE(SUM(CAST(biodegradable_subtotal AS DECIMAL(12,2))), 0) AS biodegradable,
        COALESCE(SUM(CAST(recyclable_subtotal AS DECIMAL(12,2))), 0) AS recyclable,
        COALESCE(SUM(CAST(residual_subtotal AS DECIMAL(12,2))), 0) AS residual,
        COALESCE(SUM(CAST(special_subtotal AS DECIMAL(12,2))), 0) AS special,
        COALESCE(SUM(CAST(grand_total AS DECIMAL(12,2))), 0) AS total_records_waste,
        COUNT(*) AS total_records
      FROM validated_waste_records
      WHERE LOWER(TRIM(barangay_name)) = LOWER(TRIM(?))
        AND LOWER(TRIM(validation_status)) = 'validated'
        ${yearFilter.sql}
      GROUP BY MONTH(${yearFilter.columnName})
      ORDER BY month_number ASC
    `;

    db.query(sql, [barangay], (err, rows) => {
      if (err) {
        console.error("[DB] Failed to load barangay monthly analytics:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load barangay monthly analytics",
          error: err.message
        });
      }

      const rowMap = new Map();

      (rows || []).forEach((row) => {
        rowMap.set(Number(row.month_number || 0), row);
      });

      let grandTotal = 0;
      let totalRecords = 0;

      const months = Array.from({ length: 12 }, (_, index) => {
        const monthNumber = index + 1;
        const row = rowMap.get(monthNumber) || {};

        const biodegradable = Number(row.biodegradable || 0);
        const recyclable = Number(row.recyclable || 0);
        const residual = Number(row.residual || 0);
        const special = Number(row.special || 0);
        const total = Number(row.total_records_waste || 0);
        const records = Number(row.total_records || 0);

        grandTotal += total;
        totalRecords += records;

        return {
          month: monthNumber,
          month_name: getMonthName(monthNumber),
          biodegradable,
          recyclable,
          residual,
          special,
          total,
          total_records: records,
          assistant_comment: buildMonthlyAssistantComment(
            total,
            biodegradable,
            recyclable,
            residual,
            special
          )
        };
      });

      return res.json({
        success: true,
        data: {
          barangay,
          scope: "current_year",
          year: new Date().getFullYear(),
          date_column_used: yearFilter.columnName,
          grand_total: Number(grandTotal.toFixed(2)),
          total_records: totalRecords,
          months
        }
      });
    });
  });
});


/* =========================================
   AI ANALYZE
========================================= */
router.post("/analyze", async (req, res) => {
  try {
    const { image, detectedObject, mlKitLabels } = req.body;

    console.log("---- /api/waste/analyze START ----");
    console.log("detectedObject:", detectedObject);
    console.log("hasImage:", !!image);
    console.log("imageLength:", image ? image.length : 0);
    console.log("mlKitLabels:", Array.isArray(mlKitLabels) ? mlKitLabels : []);

    if (!image || typeof image !== "string" || image.trim() === "") {
      console.error("Analyze error: image is missing");
      return res.status(400).json({
        success: false,
        message: "Image is required"
      });
    }

    let analysisResult;

    try {
      analysisResult = await analyzeWaste({
        image,
        detectedObject,
        mlKitLabels: Array.isArray(mlKitLabels) ? mlKitLabels : []
      });
    } catch (analysisError) {
      console.error("[SERVICE] analyzeWaste failed:");
      console.error(analysisError);
      console.error(analysisError.stack);

      analysisResult = buildEmergencyResult(detectedObject, mlKitLabels);
    }

    if (!analysisResult || typeof analysisResult !== "object") {
      console.error("[API] Invalid analysisResult:", analysisResult);
      analysisResult = buildEmergencyResult(detectedObject, mlKitLabels);
    }

    const itemName =
      analysisResult.itemName || analysisResult.category || "Residual";
    const category = analysisResult.category || "Residual";
    const explanation =
      analysisResult.explanation || "No explanation available.";
    const action = analysisResult.action || "No action available.";
    const warning = analysisResult.warning || "No warning available.";
    const savedDetectedObject =
      analysisResult.detectedObject || detectedObject || category || "Residual";
    const aiLabel = analysisResult.aiLabel || null;
    const aiConfidence = analysisResult.aiConfidence || null;
    const analysisSource = analysisResult.analysisSource || "fallback";

    const savedScanImage = saveScanImageFromBase64(image);
    const imageUrl = savedScanImage ? savedScanImage.imageUrl : null;

    ensureScanHistoryOptionalColumns((columnErr, columnSet) => {
      if (columnErr) {
        console.error("[DB] Failed to inspect scan_history columns before insert:", columnErr);
      }

      const insertColumns = [
        "item_name",
        "category",
        "explanation",
        "action_text",
        "warning_text",
        "detected_object",
        "image_length"
      ];

      const values = [
        String(itemName),
        String(category),
        String(explanation),
        String(action),
        String(warning),
        String(savedDetectedObject),
        Number(image.length || 0)
      ];

      if (imageUrl && hasColumn(columnSet, "image_url")) {
        insertColumns.push("image_url");
        values.push(imageUrl);
      }

      if (hasColumn(columnSet, "analysis_source")) {
        insertColumns.push("analysis_source");
        values.push(String(analysisSource || ""));
      }

      if (hasColumn(columnSet, "ai_label")) {
        insertColumns.push("ai_label");
        values.push(aiLabel ? String(aiLabel) : null);
      }

      if (hasColumn(columnSet, "ai_confidence")) {
        insertColumns.push("ai_confidence");
        values.push(aiConfidence !== null && aiConfidence !== undefined ? String(aiConfidence) : null);
      }

      const placeholders = insertColumns.map(() => "?").join(", ");

      const insertSql = `
        INSERT INTO scan_history
        (${insertColumns.join(", ")})
        VALUES (${placeholders})
      `;

      db.query(insertSql, values, (err, result) => {
        if (err) {
          console.error("[DB] Failed to save scan history:", err);
          console.error("[DB] Returning success anyway for app stability.");

          return res.json({
            success: true,
            result: {
              id: 0,
              itemName,
              category,
              explanation,
              action,
              warning,
              detectedObject: savedDetectedObject,
              imageUrl,
              image_path: imageUrl,
              image_url: imageUrl,
              aiLabel,
              aiConfidence,
              analysisSource: analysisSource + "_db_save_failed"
            }
          });
        }

        console.log("[API] Analysis saved with ID:", result.insertId);
        console.log("[API] Saved scan image URL:", imageUrl || "none");

        return res.json({
          success: true,
          result: {
            id: result.insertId,
            itemName,
            category,
            explanation,
            action,
            warning,
            detectedObject: savedDetectedObject,
            imageUrl,
            image_path: imageUrl,
            image_url: imageUrl,
            aiLabel,
            aiConfidence,
            analysisSource
          }
        });
      });
    });
  } catch (error) {
    console.error("[API] /analyze fatal error:");
    console.error(error);
    console.error(error.stack);

    const fallbackResult = buildEmergencyResult("", []);

    return res.json({
      success: true,
      result: {
        id: 0,
        itemName: fallbackResult.itemName,
        category: fallbackResult.category,
        explanation:
          "The system encountered an error and returned a safe fallback result.",
        action: fallbackResult.action,
        warning:
          "This is a fallback result because the analysis route encountered an error.",
        detectedObject: fallbackResult.detectedObject,
        aiLabel: null,
        aiConfidence: null,
        analysisSource: "fatal_route_fallback"
      }
    });
  }
});


/* =========================================
   GET SCAN HISTORY
   Includes captured scan image URL for Android detail preview.
========================================= */
router.get("/history", (req, res) => {
  ensureScanHistoryOptionalColumns((columnErr, columnSet) => {
    if (columnErr) {
      console.error("[DB] Failed to inspect scan_history columns:", columnErr);
      return res.status(500).json({
        success: false,
        message: "Failed to load scan history",
        error: columnErr.message
      });
    }

    const fields = [
      "id",
      "item_name",
      "category",
      "explanation",
      "action_text",
      "warning_text",
      "detected_object",
      "image_length",
      "created_at"
    ];

    if (hasColumn(columnSet, "image_url")) {
      fields.push("image_url");
    }

    if (hasColumn(columnSet, "analysis_source")) {
      fields.push("analysis_source");
    }

    if (hasColumn(columnSet, "ai_label")) {
      fields.push("ai_label");
    }

    if (hasColumn(columnSet, "ai_confidence")) {
      fields.push("ai_confidence");
    }

    const sql = `
      SELECT ${fields.join(", ")}
      FROM scan_history
      ORDER BY created_at DESC, id DESC
    `;

    db.query(sql, (err, rows) => {
      if (err) {
        console.error("[DB] Failed to fetch scan history:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to load scan history",
          error: err.message
        });
      }

      const history = (rows || []).map((row) => {
        const imageUrl = getFirstAvailableString(row, ["image_url"]);

        return {
          id: row.id,
          item_name: row.item_name || row.category || "Unknown Item",
          category: row.category || "Residual",
          detected_object: row.detected_object || row.item_name || row.category || "Unknown",
          created_at: row.created_at,
          explanation: row.explanation || "",
          action: row.action_text || "",
          warning: row.warning_text || "",
          analysis_source: row.analysis_source || "",
          ai_label: row.ai_label || "",
          ai_confidence: row.ai_confidence || "",
          image_path: imageUrl,
          image_url: imageUrl,
          scan_image_path: imageUrl,
          captured_image_path: imageUrl
        };
      });

      return res.json({
        success: true,
        history
      });
    });
  });
});


/* =========================================
   CLEAR ALL SCAN HISTORY
   Used by Android Scan History "Clear All".
========================================= */
router.delete("/history", (req, res) => {
  const sql = `DELETE FROM scan_history`;

  db.query(sql, (err, result) => {
    if (err) {
      console.error("[DB] Failed to clear scan history:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to clear scan history",
        error: err.message
      });
    }

    return res.json({
      success: true,
      message: "All scan history deleted successfully",
      deleted_count: result && typeof result.affectedRows === "number"
        ? result.affectedRows
        : 0
    });
  });
});

/* =========================================
   DELETE SCAN HISTORY
========================================= */
router.delete("/history/:id", (req, res) => {
  const id = Number(req.params.id);

  if (!id || id <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid history ID"
    });
  }

  const sql = `DELETE FROM scan_history WHERE id = ?`;

  db.query(sql, [id], (err, result) => {
    if (err) {
      console.error("[DB] Failed to delete scan history:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to delete scan history",
        error: err.message
      });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "History item not found"
      });
    }

    return res.json({
      success: true,
      message: "History deleted successfully"
    });
  });
});

const QRCode = require("qrcode");

router.get("/record-qr/:id", async (req, res) => {
  const { id } = req.params;

  const qrText = `WASTE:${id}`;

  try {
    const qrBuffer = await QRCode.toBuffer(qrText, {
      type: "png",
      width: 260,
      margin: 4,
      errorCorrectionLevel: "M"
    });

    res.setHeader("Content-Type", "image/png");
    res.send(qrBuffer);
  } catch (error) {
    console.error("QR generation error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate QR"
    });
  }
});

/* =========================================
   PENDING WASTE RECORDS FOR QR
========================================= */
router.post("/pending-records", (req, res) => {
  const payload = req.body;

  if (!payload || !payload.barangayName || !payload.periodFrom || !payload.periodTo) {
    return res.status(400).json({
      success: false,
      message: "Missing required waste record data"
    });
  }

  const sql = `
    INSERT INTO pending_waste_records (
      barangay_name,
      period_from,
      period_to,
      raw_payload,
      created_at
    )
    VALUES (?, ?, ?, ?, NOW())
  `;

  db.query(
    sql,
    [
      payload.barangayName,
      payload.periodFrom,
      payload.periodTo,
      JSON.stringify(payload)
    ],
    (err, result) => {
      if (err) {
        console.error("Create pending waste record error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to save pending waste record",
          error: err.message
        });
      }

      return res.json({
        success: true,
        message: "Pending waste record saved",
        id: result.insertId
      });
    }
  );
});

router.get("/pending-records/:id", (req, res) => {
  const recordId = Number(req.params.id);

  if (!recordId || recordId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid waste record ID"
    });
  }

  const sql = `
    SELECT
      id,
      barangay_name,
      period_from,
      period_to,
      raw_payload,
      created_at
    FROM pending_waste_records
    WHERE id = ?
    LIMIT 1
  `;

  db.query(sql, [recordId], (err, results) => {
    if (err) {
      console.error("Fetch pending waste record error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch pending waste record",
        error: err.message
      });
    }

    if (!results || results.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Waste record not found"
      });
    }

    const row = results[0];

    let rawPayload = {};

    try {
      rawPayload = row.raw_payload ? JSON.parse(row.raw_payload) : {};
    } catch (parseErr) {
      console.error("Invalid raw_payload JSON:", parseErr);
      rawPayload = {};
    }

    return res.json({
      success: true,
      data: {
        id: row.id,
        barangay_name: row.barangay_name,
        period_from: row.period_from,
        period_to: row.period_to,
        raw_payload: rawPayload,
        created_at: row.created_at
      }
    });
  });
});

module.exports = router;
