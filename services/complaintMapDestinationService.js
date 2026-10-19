const { resolveStrictBarangay } = require("./barangayBoundaryService");
const { key } = require("./complaintWorkflowService");

function validPoint(latitude, longitude) {
  return [latitude, longitude].every(value => (typeof value === "number" || typeof value === "string")
    && String(value).trim() !== "" && Number.isFinite(Number(value)))
    && Math.abs(Number(latitude)) <= 90 && Math.abs(Number(longitude)) <= 180;
}

// Map display only: never assigns, forwards, or learns coverage from past complaints.
async function resolveComplaintMapDestination(db, complaintId) {
  const query = (sql, values = []) => new Promise((resolve, reject) =>
    db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
  const id = Number(complaintId);
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error("Invalid complaint ID."), { statusCode: 400 });
  const [complaint] = await query(`SELECT id, latitude, longitude, status, assigned_barangay,
    assignment_confirmed_at FROM complaints WHERE id = ?`, [id]);
  if (!complaint) throw Object.assign(new Error("Complaint not found."), { statusCode: 404 });
  const unresolved = { success: true, complaint_id: id, destination: null,
    basis: "needs_admin_confirmation", label: "Needs Admin Confirmation" };
  let barangay = "", basis = "";
  let result = unresolved;
  if (complaint.assignment_confirmed_at && String(complaint.assigned_barangay || "").trim()) {
    barangay = String(complaint.assigned_barangay).trim();
    basis = "admin_confirmed";
    result = { ...unresolved, basis, assigned_barangay: barangay,
      label: `Assigned Barangay: ${barangay} — Reference location unavailable` };
    let targets;
    try {
      targets = await query("SELECT DISTINCT target_name FROM complaint_notifications WHERE complaint_id = ? AND target_type = 'barangay'", [id]);
    } catch (_) {
      return { ...result, basis: "admin_review", label: `Assigned Barangay: ${barangay} — Requires Admin review (assignment verification unavailable)` };
    }
    if (targets.length !== 1 || key(targets[0].target_name) !== key(barangay)) {
      return { ...result, basis: "admin_review", label: `Assigned Barangay: ${barangay} — Requires Admin review (conflicting or missing notification targets)` };
    }
  } else if (String(complaint.status).toLowerCase() === "pending") {
    if (!validPoint(complaint.latitude, complaint.longitude)) return unresolved;
    const boundaries = await query("SELECT barangay_name, polygon_json FROM barangay_boundaries WHERE status = 'active'");
    barangay = resolveStrictBarangay({ lat: complaint.latitude, lng: complaint.longitude }, boundaries).barangay;
    basis = "strict_polygon_suggestion";
    if (barangay) result = { ...unresolved, basis, geographic_barangay: barangay,
      label: `Geographic suggestion: ${barangay} — Needs Admin Confirmation` };
  } else {
    return { ...unresolved, basis: "admin_review", assigned_barangay: complaint.assigned_barangay || null,
      label: "Requires Admin review — Legacy assignment is not confirmed" };
  }
  if (!barangay) return unresolved;
  if (!validPoint(complaint.latitude, complaint.longitude)) return result;
  let references;
  try {
    references = await query(`SELECT barangay_name, reference_name, latitude, longitude
      FROM barangay_reference_points WHERE status = 'active' AND TRIM(barangay_name) = ?`, [barangay]);
  } catch (_) { return result; }
  // Fail closed on missing/ambiguous/invalid references; never pick a nearest/first point.
  const exact = references.filter(row => String(row.barangay_name || "").trim() === barangay);
  if (exact.length !== 1 || !validPoint(exact[0].latitude, exact[0].longitude)) return result;
  return { ...result,
    label: basis === "admin_confirmed" ? `Assigned Barangay: ${barangay}` : result.label,
    destination: { barangay_name: barangay, reference_name: exact[0].reference_name,
      latitude: Number(exact[0].latitude), longitude: Number(exact[0].longitude) } };
}

module.exports = { resolveComplaintMapDestination, validPoint };
