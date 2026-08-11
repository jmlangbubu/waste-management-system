-- Reviewed-only migration. Do not run automatically from application startup.

CREATE TABLE IF NOT EXISTS web_admin_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  csrf_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_web_admin_sessions_token_hash (session_token_hash),
  KEY idx_web_admin_sessions_user_active (user_id, revoked_at, expires_at),
  KEY idx_web_admin_sessions_expires_at (expires_at),
  KEY idx_web_admin_sessions_last_seen_at (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
