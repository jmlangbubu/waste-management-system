-- Enforcer Team + Multiple AOR foundation. MANUAL EXECUTION ONLY.
-- Verify users.id is signed INT/InnoDB before execution (matches existing FKs).
-- No users schema changes and no automatic user/membership migration.

CREATE TABLE IF NOT EXISTS enforcer_teams (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  team_name VARCHAR(100) NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_enforcer_teams_name (team_name),
  KEY idx_enforcer_teams_status (status, team_name)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS enforcer_team_aors (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  team_id INT UNSIGNED NOT NULL,
  barangay_name VARCHAR(150) NOT NULL,
  sort_order INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_enforcer_team_aor (team_id, barangay_name),
  KEY idx_enforcer_team_aor_order (team_id, sort_order, id),
  CONSTRAINT fk_enforcer_team_aor_team FOREIGN KEY (team_id) REFERENCES enforcer_teams (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS enforcer_team_members (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  team_id INT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_enforcer_team_member_user (user_id),
  KEY idx_enforcer_team_members_team (team_id, user_id),
  CONSTRAINT fk_enforcer_team_member_team FOREIGN KEY (team_id) REFERENCES enforcer_teams (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_enforcer_team_member_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Re-runnable seeds preserve existing team statuses and AOR ordering.
-- Neutral identifiers only: no named personnel or user accounts are created.
START TRANSACTION;
INSERT INTO enforcer_teams (team_name) VALUES
  ('Team 01'), ('Team 02'), ('Team 03'), ('Team 04'), ('Team 05'), ('Team 06'),
  ('Team 07'), ('Team 08'), ('Team 09'), ('Team 10'), ('Team 11'), ('Team 12')
ON DUPLICATE KEY UPDATE team_name = VALUES(team_name);

INSERT INTO enforcer_team_aors (team_id, barangay_name, sort_order)
SELECT t.id, seed.barangay_name, seed.sort_order
FROM (
  SELECT 'Team 01' AS team_name, 'City Heights' AS barangay_name, 1 AS sort_order
  UNION ALL SELECT 'Team 01', 'Conel', 2
  UNION ALL SELECT 'Team 01', 'San Isidro', 3
  UNION ALL SELECT 'Team 02', 'Baluan', 1
  UNION ALL SELECT 'Team 02', 'Buayan', 2
  UNION ALL SELECT 'Team 02', 'Katangawan', 3
  UNION ALL SELECT 'Team 02', 'Ligaya', 4
  UNION ALL SELECT 'Team 03', 'Dadiangas East', 1
  UNION ALL SELECT 'Team 04', 'Dadiangas North', 1
  UNION ALL SELECT 'Team 05', 'Dadiangas South', 1
  UNION ALL SELECT 'Team 06', 'Dadiangas West', 1
  UNION ALL SELECT 'Team 07', 'Batomelong', 1
  UNION ALL SELECT 'Team 08', 'Mabuhay', 1
  UNION ALL SELECT 'Team 08', 'Olympog', 2
  UNION ALL SELECT 'Team 08', 'Tinagacan', 3
  UNION ALL SELECT 'Team 08', 'Upper Labay', 4
  UNION ALL SELECT 'Team 09', 'Calumpang', 1
  UNION ALL SELECT 'Team 09', 'Fatima', 2
  UNION ALL SELECT 'Team 09', 'Siguel', 3
  UNION ALL SELECT 'Team 09', 'Tambler', 4
  UNION ALL SELECT 'Team 10', 'Bula', 1
  UNION ALL SELECT 'Team 11', 'Lagao', 1
  UNION ALL SELECT 'Team 12', 'Apopong', 1
  UNION ALL SELECT 'Team 12', 'Labangal', 2
  UNION ALL SELECT 'Team 12', 'San Jose', 3
  UNION ALL SELECT 'Team 12', 'Sinawal', 4
) seed JOIN enforcer_teams t ON t.team_name = seed.team_name
ON DUPLICATE KEY UPDATE barangay_name = VALUES(barangay_name);
COMMIT;
