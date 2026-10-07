-- MANUAL EXECUTION ONLY. Verify users.id is signed INT PRIMARY KEY and InnoDB.
-- Additive direct assignments only; no users or historical team rows are changed.
CREATE TABLE IF NOT EXISTS enforcer_aors (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  barangay_name VARCHAR(150) NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_enforcer_aors_barangay (barangay_name),
  KEY idx_enforcer_aors_status (status, barangay_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS enforcer_user_aors (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  aor_id INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_enforcer_user_aor (user_id, aor_id),
  KEY idx_enforcer_user_aor_aor (aor_id),
  CONSTRAINT fk_enforcer_user_aor_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_enforcer_user_aor_aor FOREIGN KEY (aor_id) REFERENCES enforcer_aors (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

START TRANSACTION;
INSERT INTO enforcer_aors (barangay_name) VALUES
  ('Apopong'), ('Baluan'), ('Batomelong'), ('Buayan'), ('Bula'), ('Calumpang'),
  ('City Heights'), ('Conel'), ('Dadiangas East'), ('Dadiangas North'),
  ('Dadiangas South'), ('Dadiangas West'), ('Fatima'), ('Katangawan'),
  ('Labangal'), ('Lagao'), ('Ligaya'), ('Mabuhay'), ('Olympog'), ('San Isidro'),
  ('San Jose'), ('Siguel'), ('Sinawal'), ('Tambler'), ('Tinagacan'), ('Upper Labay')
ON DUPLICATE KEY UPDATE barangay_name = enforcer_aors.barangay_name;
COMMIT;
