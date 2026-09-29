-- Validated Waste Record corrections rollback. MANUAL EXECUTION ONLY.
-- DESTRUCTIVE: permanently removes correction requests and audit history.
-- Require a verified backup and explicit approval before any execution.
-- Drop the dependent audit table before the request table.

DROP TABLE IF EXISTS waste_record_correction_audit;
DROP TABLE IF EXISTS waste_record_correction_requests;
