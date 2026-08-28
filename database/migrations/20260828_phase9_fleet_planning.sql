-- Phase 9 fleet and dispatch-planning schema.
-- DRAFT / MANUAL EXECUTION ONLY.
--
-- This migration must not be loaded or executed by application startup.
-- It creates empty tables only. It does not alter the legacy `trucks` table,
-- seed fleet records, or modify existing dispatch/tracking data.

CREATE TABLE fleet_trucks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  truck_code VARCHAR(100) NOT NULL,
  truck_name VARCHAR(150) NOT NULL,
  plate_number VARCHAR(50) NULL,
  fleet_condition ENUM(
    'available',
    'for_maintenance',
    'out_of_service'
  ) NOT NULL DEFAULT 'available',
  condition_reason VARCHAR(500) NULL,
  condition_updated_by_web_user_id INT NULL,
  condition_updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by_web_user_id INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fleet_trucks_truck_code (truck_code),
  UNIQUE KEY uq_fleet_trucks_plate_number (plate_number),
  KEY idx_fleet_trucks_condition (fleet_condition),
  KEY idx_fleet_trucks_name (truck_name),
  KEY idx_fleet_trucks_condition_actor (condition_updated_by_web_user_id),
  KEY idx_fleet_trucks_creator (created_by_web_user_id),
  CONSTRAINT fk_fleet_trucks_condition_actor
    FOREIGN KEY (condition_updated_by_web_user_id)
    REFERENCES web_users (id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  CONSTRAINT fk_fleet_trucks_creator
    FOREIGN KEY (created_by_web_user_id)
    REFERENCES web_users (id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operational_date DATE NOT NULL,
  fleet_truck_id INT UNSIGNED NOT NULL,
  truck_code_snapshot VARCHAR(100) NOT NULL,
  truck_name_snapshot VARCHAR(150) NOT NULL,
  assigned_enforcer_user_id INT NOT NULL,
  assigned_enforcer_name_snapshot VARCHAR(255) NOT NULL,
  route_name VARCHAR(180) NOT NULL,
  route_description TEXT NULL,
  planned_route_snapshot JSON NULL,
  stop_signature VARCHAR(4096) NULL,
  scheduled_start_at DATETIME(3) NULL,
  expected_return_at DATETIME(3) NULL,
  status ENUM(
    'planned',
    'activated',
    'cancelled'
  ) NOT NULL DEFAULT 'planned',
  notes TEXT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_by_web_user_id INT NOT NULL,
  updated_by_web_user_id INT NULL,
  cancelled_by_web_user_id INT NULL,
  cancellation_reason VARCHAR(1000) NULL,
  cancelled_at DATETIME(3) NULL,
  activation_action_id VARCHAR(160) NULL,
  activated_tracking_session_id INT NULL,
  activated_dispatch_ticket_id INT UNSIGNED NULL,
  activated_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  conflict_truck_id INT UNSIGNED
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('planned', 'activated') THEN fleet_truck_id
        ELSE NULL
      END
    ) STORED,
  conflict_enforcer_user_id INT
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN ('planned', 'activated') THEN assigned_enforcer_user_id
        ELSE NULL
      END
    ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dispatch_plans_truck_day (
    operational_date,
    conflict_truck_id
  ),
  UNIQUE KEY uq_dispatch_plans_enforcer_day (
    operational_date,
    conflict_enforcer_user_id
  ),
  UNIQUE KEY uq_dispatch_plans_activation_action (activation_action_id),
  UNIQUE KEY uq_dispatch_plans_tracking_session (activated_tracking_session_id),
  UNIQUE KEY uq_dispatch_plans_dispatch_ticket (activated_dispatch_ticket_id),
  KEY idx_dispatch_plans_date_status (operational_date, status),
  KEY idx_dispatch_plans_fleet_truck (fleet_truck_id),
  KEY idx_dispatch_plans_enforcer (assigned_enforcer_user_id),
  KEY idx_dispatch_plans_creator (created_by_web_user_id),
  KEY idx_dispatch_plans_editor (updated_by_web_user_id),
  KEY idx_dispatch_plans_canceller (cancelled_by_web_user_id),
  CONSTRAINT fk_dispatch_plans_fleet_truck
    FOREIGN KEY (fleet_truck_id)
    REFERENCES fleet_trucks (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_plans_enforcer
    FOREIGN KEY (assigned_enforcer_user_id)
    REFERENCES users (id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_plans_creator
    FOREIGN KEY (created_by_web_user_id)
    REFERENCES web_users (id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_plans_editor
    FOREIGN KEY (updated_by_web_user_id)
    REFERENCES web_users (id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  CONSTRAINT fk_dispatch_plans_canceller
    FOREIGN KEY (cancelled_by_web_user_id)
    REFERENCES web_users (id)
    ON UPDATE CASCADE
    ON DELETE SET NULL,
  CONSTRAINT fk_dispatch_plans_tracking_session
    FOREIGN KEY (activated_tracking_session_id)
    REFERENCES truck_tracking_sessions (id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT fk_dispatch_plans_dispatch_ticket
    FOREIGN KEY (activated_dispatch_ticket_id)
    REFERENCES dispatch_tickets (id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dispatch_plan_stops (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dispatch_plan_id BIGINT UNSIGNED NOT NULL,
  stop_order SMALLINT UNSIGNED NOT NULL,
  destination_id BIGINT UNSIGNED NULL,
  location_name_snapshot VARCHAR(180) NOT NULL,
  address_reference_snapshot VARCHAR(255) NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  geofence_radius_meters SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  expected_arrival_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_dispatch_plan_stops_order (dispatch_plan_id, stop_order),
  KEY idx_dispatch_plan_stops_destination (destination_id),
  CONSTRAINT fk_dispatch_plan_stops_plan
    FOREIGN KEY (dispatch_plan_id)
    REFERENCES dispatch_plans (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT fk_dispatch_plan_stops_destination
    FOREIGN KEY (destination_id)
    REFERENCES gensan_dispatch_destinations (id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mobile_user_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  device_id VARCHAR(150) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mobile_user_sessions_token_hash (session_token_hash),
  KEY idx_mobile_user_sessions_user_active (user_id, revoked_at, expires_at),
  KEY idx_mobile_user_sessions_expires_at (expires_at),
  KEY idx_mobile_user_sessions_last_seen_at (last_seen_at),
  CONSTRAINT fk_mobile_user_sessions_user
    FOREIGN KEY (user_id)
    REFERENCES users (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
