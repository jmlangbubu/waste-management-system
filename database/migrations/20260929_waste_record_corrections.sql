-- Phase 2 validated Waste Record corrections. MANUAL EXECUTION ONLY.
-- Review against the target database before applying; startup never runs this file.
-- Live read-only verification confirmed existing validated record and web user
-- IDs are INT, with InnoDB and utf8mb4_general_ci. References are indexed IDs
-- without new foreign keys because deletion/lifecycle policy remains unresolved.

CREATE TABLE waste_record_correction_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  waste_record_id INT NOT NULL,
  requested_by_user_id INT NOT NULL,
  requested_by_role VARCHAR(40) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  original_values JSON NOT NULL,
  proposed_values JSON NOT NULL,
  status ENUM('pending', 'approved', 'rejected', 'applied', 'cancelled') NOT NULL DEFAULT 'pending',
  reviewed_by_user_id INT NULL,
  reviewed_by_role VARCHAR(40) NULL,
  decision_reason VARCHAR(1000) NULL,
  reviewed_at DATETIME(3) NULL,
  applied_by_user_id INT NULL,
  applied_by_role VARCHAR(40) NULL,
  applied_at DATETIME(3) NULL,
  cancelled_by_user_id INT NULL,
  cancelled_by_role VARCHAR(40) NULL,
  cancel_reason VARCHAR(1000) NULL,
  cancelled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_waste_correction_record_status (waste_record_id, status, created_at),
  KEY idx_waste_correction_status_created (status, created_at),
  KEY idx_waste_correction_requester (requested_by_user_id),
  KEY idx_waste_correction_reviewer (reviewed_by_user_id),
  KEY idx_waste_correction_applier (applied_by_user_id),
  KEY idx_waste_correction_canceller (cancelled_by_user_id)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_general_ci;

CREATE TABLE waste_record_correction_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  waste_record_id INT NOT NULL,
  correction_request_id BIGINT UNSIGNED NOT NULL,
  old_values JSON NOT NULL,
  new_values JSON NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  requested_by_user_id INT NOT NULL,
  approved_by_user_id INT NOT NULL,
  applied_by_user_id INT NOT NULL,
  requested_by_role VARCHAR(40) NOT NULL,
  approved_by_role VARCHAR(40) NOT NULL,
  applied_by_role VARCHAR(40) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_waste_correction_audit_request (correction_request_id),
  KEY idx_waste_correction_audit_record_created (waste_record_id, created_at),
  KEY idx_waste_correction_audit_requester (requested_by_user_id),
  KEY idx_waste_correction_audit_approver (approved_by_user_id),
  KEY idx_waste_correction_audit_applier (applied_by_user_id)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_general_ci;
