-- REVIEW ONLY: every statement below is commented to prevent partial execution.
-- Prepare a separately approved migration after verifying the actual schema.
-- DRAFT ONLY: NOT EXECUTABLE UNTIL <EXACT_APPOINTMENTS_ID_TYPE> is replaced
-- from separately authorized schema evidence. Do not run against production.
-- Requires MySQL 8 transactional InnoDB tables, including appointments/notifications.
-- Review appointment_revision compatibility with ALL appointment writers first.

-- ALTER TABLE appointments ADD COLUMN appointment_revision BIGINT UNSIGNED NOT NULL DEFAULT 0;

-- CREATE TABLE appointment_feature_state (
--   feature_key VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
--   schema_version INT NOT NULL,
--   backfill_complete TINYINT NOT NULL DEFAULT 0
-- ) ENGINE=InnoDB;

-- CREATE TABLE appointment_reservations (
--   service_key VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
--   appointment_date DATE NOT NULL,
--   appointment_time TIME NOT NULL,
--   appointment_id <EXACT_APPOINTMENTS_ID_TYPE> NOT NULL,
--   PRIMARY KEY (service_key, appointment_date, appointment_time),
--   UNIQUE KEY reservation_appointment (appointment_id),
--   FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE RESTRICT
-- ) ENGINE=InnoDB;

-- CREATE TABLE appointment_booking_requests (
--   request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
--   payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
--   appointment_id <EXACT_APPOINTMENTS_ID_TYPE> NULL,
--   appointment_code VARCHAR(32) NULL,
--   UNIQUE KEY request_appointment (appointment_id),
--   FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE RESTRICT
-- ) ENGINE=InnoDB;

-- Marker stays UNREADY until a separately approved, complete conflict-free backfill.
-- INSERT INTO appointment_feature_state (feature_key, schema_version, backfill_complete)
-- VALUES ('service_slots', 1, 0);

-- Deliberately no activation statement, automatic backfill, or destructive rollback.
