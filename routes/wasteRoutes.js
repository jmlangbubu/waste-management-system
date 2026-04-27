const express = require("express");
const router = express.Router();
const db = require("../config/db");
const { analyzeWaste } = require("../services/wasteAnalysisService");
const wasteController = require("../controllers/wasteController");

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

    const insertSql = `
      INSERT INTO scan_history
      (item_name, category, explanation, action_text, warning_text, detected_object, image_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      String(itemName),
      String(category),
      String(explanation),
      String(action),
      String(warning),
      String(savedDetectedObject),
      Number(image.length || 0)
    ];

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
            aiLabel,
            aiConfidence,
            analysisSource: analysisSource + "_db_save_failed"
          }
        });
      }

      console.log("[API] Analysis saved with ID:", result.insertId);

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
          aiLabel,
          aiConfidence,
          analysisSource
        }
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