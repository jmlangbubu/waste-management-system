-- STAGING ONLY. Apply manually to a NEW EMPTY wmo_appointment_staging_* database.
-- No production schema export or production migration is represented here.
-- Synthetic compatible base tables plus the reviewed reservation structure.
-- No database creation/selection, accounts, grants, activation or destructive SQL.
CREATE TABLE appointments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  appointment_code VARCHAR(30) NULL DEFAULT NULL,
  full_name VARCHAR(150) NOT NULL,
  barangay VARCHAR(150) NOT NULL,
  contact_number VARCHAR(50) NOT NULL,
  email VARCHAR(255) NULL DEFAULT NULL,
  purpose VARCHAR(100) NOT NULL,
  preferred_date DATETIME NULL DEFAULT NULL,
  notes TEXT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  assigned_to VARCHAR(255) NULL DEFAULT NULL,
  assigned_personnel_id INT NULL DEFAULT NULL,
  assigned_personnel_name VARCHAR(150) NULL DEFAULT NULL,
  assigned_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  orientation_token VARCHAR(100) NULL DEFAULT NULL,
  orientation_qr_status VARCHAR(30) NULL DEFAULT 'not_generated',
  orientation_completed TINYINT NOT NULL DEFAULT 0,
  orientation_status VARCHAR(50) NULL DEFAULT 'approved',
  orientation_started_at DATETIME NULL DEFAULT NULL,
  orientation_completed_at DATETIME NULL DEFAULT NULL,
  orientation_score INT NULL DEFAULT NULL,
  appointment_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY appointment_code (appointment_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE notifications (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(50) NULL,
  title VARCHAR(255) NULL,
  message TEXT NULL,
  isRead TINYINT NULL DEFAULT 0,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(80) NULL DEFAULT NULL,
  reference_id VARCHAR(120) NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE appointment_reservations (
  service_key VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  appointment_date DATE NOT NULL,
  appointment_time TIME NOT NULL,
  appointment_id INT NOT NULL,
  PRIMARY KEY (service_key, appointment_date, appointment_time),
  UNIQUE KEY reservation_appointment (appointment_id),
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE appointment_booking_requests (
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  appointment_id INT NULL DEFAULT NULL,
  appointment_code VARCHAR(30) NULL DEFAULT NULL,
  UNIQUE KEY request_appointment (appointment_id),
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE appointment_feature_state (
  feature_key VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  schema_version INT NOT NULL,
  backfill_complete TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE web_users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  username VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  division_name VARCHAR(100) NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'active'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE web_admin_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  user_id INT NOT NULL,
  csrf_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL DEFAULT NULL,
  KEY user_active (user_id, revoked_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Deliberately UNREADY. Only the explicitly authorized test process attests its empty fixture.
INSERT INTO appointment_feature_state (feature_key, schema_version, backfill_complete)
VALUES ('service_slots', 1, 0);
