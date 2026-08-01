-- General Santos dispatch destination catalog tables
-- Reviewed against services/dispatchService.js and the generated catalog seed.
-- Manual execution only. This file is not loaded by server startup.
-- This DDL creates empty tables and does not insert destination records.

CREATE TABLE IF NOT EXISTS gensan_dispatch_destinations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  destination_type ENUM('road_segment', 'barangay_hall', 'road') NOT NULL
    COMMENT 'road is retained only for legacy-row compatibility',
  name VARCHAR(255) NOT NULL,
  barangay VARCHAR(100) NULL,
  display_label VARCHAR(255) NOT NULL,
  latitude DECIMAL(10, 7) NOT NULL,
  longitude DECIMAL(10, 7) NOT NULL,
  aliases JSON NULL,
  search_keywords JSON NULL,
  osm_type VARCHAR(16) NULL,
  osm_id VARCHAR(64) NULL,
  is_verified TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gdd_osm_object (osm_type, osm_id),
  KEY idx_gdd_destination_type (destination_type),
  KEY idx_gdd_verified_active_type (is_verified, is_active, destination_type),
  KEY idx_gdd_is_active (is_active),
  KEY idx_gdd_barangay (barangay),
  KEY idx_gdd_name (name),
  KEY idx_gdd_display_label (display_label)
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gensan_dispatch_destination_points (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  destination_id BIGINT UNSIGNED NOT NULL,
  point_order INT UNSIGNED NOT NULL,
  point_type ENUM('entry', 'geometry', 'middle', 'exit', 'anchor') NOT NULL,
  latitude DECIMAL(10, 7) NOT NULL,
  longitude DECIMAL(10, 7) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gddp_destination_order (destination_id, point_order),
  KEY idx_gddp_destination_type (destination_id, point_type),
  CONSTRAINT fk_gddp_destination
    FOREIGN KEY (destination_id)
    REFERENCES gensan_dispatch_destinations (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARACTER SET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
