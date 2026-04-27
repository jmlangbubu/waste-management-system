const db = require("../config/dbPromise");

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

/* =========================================
   CREATE VALIDATED WASTE RECORD
========================================= */
const createValidatedWasteRecord = async (req, res) => {
  try {
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
    } = req.body;

    const normalizedRawPayload = normalizeRawPayload(raw_payload);

    const [result] = await db.query(
      `
      INSERT INTO validated_waste_records (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        entry_type || null,
        barangay_name || null,
        establishment_name || null,
        barangay_address || null,
        establishment_address || null,
        source_type || null,
        period_from || null,
        period_to || null,
        remarks || null,
        Number(biodegradable_subtotal || 0),
        Number(recyclable_subtotal || 0),
        Number(residual_subtotal || 0),
        Number(special_subtotal || 0),
        Number(grand_total || 0),
        validation_status || "Validated",
        validated_by || null,
        enforcer_signature || null,
        validated_at || new Date(),
        validation_notes || null,
        normalizedRawPayload
      ]
    );

    await db.query(
      `
      INSERT INTO notifications (type, title, message)
      VALUES (?, ?, ?)
    `,
      [
        "waste_report",
        "New Validated Waste Record",
        `${barangay_name || establishment_name || "Unknown source"} • Validated waste submission`
      ]
    );

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
      error: error.message
    });
  }
};

/* =========================================
   GET VALIDATED WASTE RECORDS
========================================= */
const getValidatedWasteRecords = async (req, res) => {
  try {
    const [results] = await db.query(
      `
      SELECT
        id,
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
        raw_payload,
        created_at
      FROM validated_waste_records
      ORDER BY COALESCE(validated_at, created_at) DESC, id DESC
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
      error: error.message
    });
  }
};

module.exports = {
  createValidatedWasteRecord,
  getValidatedWasteRecords
};