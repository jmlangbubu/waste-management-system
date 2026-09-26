-- Vehicle Issue Reporting Phase 1 schema.
-- MANUAL EXECUTION ONLY. Application startup must not execute this migration.

CREATE TABLE vehicle_issue_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_request_id VARCHAR(160)
    CHARACTER SET ascii
    COLLATE ascii_bin
    NOT NULL,
  fleet_truck_id INT UNSIGNED NOT NULL,
  truck_code_snapshot VARCHAR(100) NOT NULL,
  truck_name_snapshot VARCHAR(150) NOT NULL,
  reported_by_user_id INT NOT NULL,
  reported_by_name_snapshot VARCHAR(255) NOT NULL,
  dispatch_plan_id BIGINT UNSIGNED NOT NULL,
  dispatch_ticket_id INT UNSIGNED NOT NULL,
  tracking_session_id INT NOT NULL,
  issue_category VARCHAR(40) NOT NULL,
  description VARCHAR(1000) NOT NULL,
  assistant_answers JSON NOT NULL,
  assistant_ruleset_version VARCHAR(40) NOT NULL,
  severity ENUM(
    'low',
    'moderate',
    'critical'
  ) NOT NULL,
  possible_concern VARCHAR(500) NOT NULL,
  recommended_action VARCHAR(1000) NOT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  accuracy_meters DECIMAL(8,2) NULL,
  location_recorded_at DATETIME(3) NULL,
  image_url VARCHAR(1000) NULL,
  report_status ENUM(
    'submitted',
    'under_review',
    'resolved'
  ) NOT NULL DEFAULT 'submitted',
  reviewed_by_web_user_id INT NULL,
  reviewed_at DATETIME(3) NULL,
  resolution_action ENUM(
    'continue_operation',
    'set_for_maintenance',
    'set_out_of_service'
  ) NULL,
  resolution_notes VARCHAR(1000) NULL,
  resolved_by_web_user_id INT NULL,
  resolved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_vehicle_issue_reports_client_request (client_request_id),
  KEY idx_vehicle_issue_reports_truck_status_created (
    fleet_truck_id,
    report_status,
    created_at
  ),
  KEY idx_vehicle_issue_reports_severity_status_created (
    severity,
    report_status,
    created_at
  ),
  KEY idx_vehicle_issue_reports_reporter (reported_by_user_id),
  KEY idx_vehicle_issue_reports_plan (dispatch_plan_id),
  KEY idx_vehicle_issue_reports_ticket (dispatch_ticket_id),
  KEY idx_vehicle_issue_reports_tracking (tracking_session_id),
  KEY idx_vehicle_issue_reports_reviewer (reviewed_by_web_user_id),
  KEY idx_vehicle_issue_reports_resolver (resolved_by_web_user_id),
  CONSTRAINT chk_vehicle_issue_reports_category CHECK (
    issue_category IN (
      'engine_overheating',
      'brakes',
      'tires',
      'steering',
      'electrical_battery',
      'lights',
      'noise_vibration',
      'other'
    )
  ),
  CONSTRAINT fk_vehicle_issue_reports_fleet_truck
    FOREIGN KEY (fleet_truck_id)
    REFERENCES fleet_trucks (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_vehicle_issue_reports_reporter
    FOREIGN KEY (reported_by_user_id)
    REFERENCES users (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_vehicle_issue_reports_plan
    FOREIGN KEY (dispatch_plan_id)
    REFERENCES dispatch_plans (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_vehicle_issue_reports_ticket
    FOREIGN KEY (dispatch_ticket_id)
    REFERENCES dispatch_tickets (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_vehicle_issue_reports_tracking
    FOREIGN KEY (tracking_session_id)
    REFERENCES truck_tracking_sessions (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_vehicle_issue_reports_reviewer
    FOREIGN KEY (reviewed_by_web_user_id)
    REFERENCES web_users (id)
    ON UPDATE RESTRICT
    ON DELETE SET NULL,
  CONSTRAINT fk_vehicle_issue_reports_resolver
    FOREIGN KEY (resolved_by_web_user_id)
    REFERENCES web_users (id)
    ON UPDATE RESTRICT
    ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
