-- STAGING ONLY: manually apply to a fresh empty wmo_appointment_staging_* schema.
-- Pre-migration SYNTHETIC profile, not an exact production clone.
-- Appointment/notification shapes follow reviewed Q4 metadata and the prior test fixture.
-- Literal defaults are explicit test assumptions; unknown defaults/triggers must not be accepted.
-- Only the quiz -> signed appointments.id relationship is confirmed. Its minimal
-- id/appointment_id layout and RESTRICT actions below are synthetic assumptions.
-- No revision/infrastructure tables, rows, activation, database selection or destructive SQL.
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

CREATE TABLE orientation_quiz_results (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  appointment_id INT NOT NULL,
  KEY legacy_quiz_appointment (appointment_id),
  CONSTRAINT legacy_quiz_fk FOREIGN KEY (appointment_id)
    REFERENCES appointments(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;
