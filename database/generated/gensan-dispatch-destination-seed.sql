-- General Santos dispatch destination catalog seed
-- Generated from OpenStreetMap Overpass data at 2026-08-01T05:25:42.716Z
-- Review before manual execution. This script does not create or alter tables.
-- Idempotency key: (osm_type, osm_id); destination points: (destination_id, point_order).
START TRANSACTION;

INSERT INTO gensan_dispatch_destinations (
  destination_type, name, barangay, display_label, latitude, longitude,
  aliases, search_keywords, osm_type, osm_id, is_verified, is_active, created_at, updated_at
)
SELECT 'barangay_hall', 'Sangguniang Barangay ng Labangal', 'Labangal', 'Sangguniang Barangay ng Labangal, Labangal', 6.0943913, 125.1521597, '[]', '["sangguniang ng labangal","labangal","hall","general santos city"]', 'node', '9598831852', 1, 1, NOW(), NOW()
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM gensan_dispatch_destinations
  WHERE osm_type = 'node' AND osm_id = '9598831852'
);
UPDATE gensan_dispatch_destinations
SET destination_type = 'barangay_hall', name = 'Sangguniang Barangay ng Labangal',
    barangay = 'Labangal', display_label = 'Sangguniang Barangay ng Labangal, Labangal',
    latitude = 6.0943913, longitude = 125.1521597,
    aliases = '[]', search_keywords = '["sangguniang ng labangal","labangal","hall","general santos city"]',
    is_verified = 1, is_active = 1, updated_at = NOW()
WHERE osm_type = 'node' AND osm_id = '9598831852';
SET @destination_id = (SELECT id FROM gensan_dispatch_destinations WHERE osm_type = 'node' AND osm_id = '9598831852' ORDER BY id ASC LIMIT 1);
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 1, 'anchor', 6.0943913, 125.1521597, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 1
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'anchor', latitude = 6.0943913, longitude = 125.1521597
WHERE destination_id = @destination_id AND point_order = 1;

INSERT INTO gensan_dispatch_destinations (
  destination_type, name, barangay, display_label, latitude, longitude,
  aliases, search_keywords, osm_type, osm_id, is_verified, is_active, created_at, updated_at
)
SELECT 'road_segment', 'Irineo Santiago Boulevard', NULL, 'Santiago Boulevard', 6.1128375, 125.1795323, '["Santiago Blvd","Irineo Santiago Boulevard","Irineo Santiago Blvd"]', '["santiago boulevard","irineo santiago boulevard","santiago blvd","irineo santiago blvd","general santos city"]', 'way', '33274783', 1, 1, NOW(), NOW()
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM gensan_dispatch_destinations
  WHERE osm_type = 'way' AND osm_id = '33274783'
);
UPDATE gensan_dispatch_destinations
SET destination_type = 'road_segment', name = 'Irineo Santiago Boulevard',
    barangay = NULL, display_label = 'Santiago Boulevard',
    latitude = 6.1128375, longitude = 125.1795323,
    aliases = '["Santiago Blvd","Irineo Santiago Boulevard","Irineo Santiago Blvd"]', search_keywords = '["santiago boulevard","irineo santiago boulevard","santiago blvd","irineo santiago blvd","general santos city"]',
    is_verified = 1, is_active = 1, updated_at = NOW()
WHERE osm_type = 'way' AND osm_id = '33274783';
SET @destination_id = (SELECT id FROM gensan_dispatch_destinations WHERE osm_type = 'way' AND osm_id = '33274783' ORDER BY id ASC LIMIT 1);
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 1, 'entry', 6.1163568, 125.1795101, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 1
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'entry', latitude = 6.1163568, longitude = 125.1795101
WHERE destination_id = @destination_id AND point_order = 1;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 2, 'geometry', 6.1162121, 125.1795057, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 2
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1162121, longitude = 125.1795057
WHERE destination_id = @destination_id AND point_order = 2;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 3, 'geometry', 6.1161631, 125.1795084, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 3
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1161631, longitude = 125.1795084
WHERE destination_id = @destination_id AND point_order = 3;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 4, 'geometry', 6.1159723, 125.1795191, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 4
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1159723, longitude = 125.1795191
WHERE destination_id = @destination_id AND point_order = 4;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 5, 'geometry', 6.1155539, 125.1795209, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 5
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1155539, longitude = 125.1795209
WHERE destination_id = @destination_id AND point_order = 5;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 6, 'geometry', 6.1151647, 125.1795225, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 6
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1151647, longitude = 125.1795225
WHERE destination_id = @destination_id AND point_order = 6;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 7, 'geometry', 6.1150974, 125.1795228, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 7
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1150974, longitude = 125.1795228
WHERE destination_id = @destination_id AND point_order = 7;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 8, 'geometry', 6.1146889, 125.1795245, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 8
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1146889, longitude = 125.1795245
WHERE destination_id = @destination_id AND point_order = 8;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 9, 'geometry', 6.1140705, 125.1795271, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 9
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1140705, longitude = 125.1795271
WHERE destination_id = @destination_id AND point_order = 9;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 10, 'geometry', 6.1136679, 125.1795288, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 10
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1136679, longitude = 125.1795288
WHERE destination_id = @destination_id AND point_order = 10;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 11, 'geometry', 6.1136095, 125.1795290, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 11
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1136095, longitude = 125.1795290
WHERE destination_id = @destination_id AND point_order = 11;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 12, 'geometry', 6.1120498, 125.1795356, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 12
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1120498, longitude = 125.1795356
WHERE destination_id = @destination_id AND point_order = 12;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 13, 'geometry', 6.1117856, 125.1795326, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 13
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1117856, longitude = 125.1795326
WHERE destination_id = @destination_id AND point_order = 13;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 14, 'geometry', 6.1112697, 125.1795268, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 14
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1112697, longitude = 125.1795268
WHERE destination_id = @destination_id AND point_order = 14;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 15, 'geometry', 6.1110788, 125.1795276, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 15
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1110788, longitude = 125.1795276
WHERE destination_id = @destination_id AND point_order = 15;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 16, 'geometry', 6.1109412, 125.1795281, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 16
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1109412, longitude = 125.1795281
WHERE destination_id = @destination_id AND point_order = 16;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 17, 'geometry', 6.1108453, 125.1795292, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 17
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1108453, longitude = 125.1795292
WHERE destination_id = @destination_id AND point_order = 17;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 18, 'geometry', 6.1108012, 125.1795294, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 18
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1108012, longitude = 125.1795294
WHERE destination_id = @destination_id AND point_order = 18;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 19, 'geometry', 6.1106765, 125.1795309, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 19
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1106765, longitude = 125.1795309
WHERE destination_id = @destination_id AND point_order = 19;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 20, 'geometry', 6.1093660, 125.1795468, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 20
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1093660, longitude = 125.1795468
WHERE destination_id = @destination_id AND point_order = 20;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 21, 'exit', 6.1093179, 125.1795470, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 21
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'exit', latitude = 6.1093179, longitude = 125.1795470
WHERE destination_id = @destination_id AND point_order = 21;

INSERT INTO gensan_dispatch_destinations (
  destination_type, name, barangay, display_label, latitude, longitude,
  aliases, search_keywords, osm_type, osm_id, is_verified, is_active, created_at, updated_at
)
SELECT 'road_segment', 'Jose Catolico Sr. Avenue', NULL, 'Jose Catolico Avenue', 6.1161459, 125.1848263, '["Jose Catolico","Jose Catolico Ave","Jose Catolico Sr Avenue","Jose Catolico Sr. Avenue"]', '["jose catolico avenue","jose catolico sr avenue","jose catolico","jose catolico ave","general santos city"]', 'way', '1287970427', 1, 1, NOW(), NOW()
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM gensan_dispatch_destinations
  WHERE osm_type = 'way' AND osm_id = '1287970427'
);
UPDATE gensan_dispatch_destinations
SET destination_type = 'road_segment', name = 'Jose Catolico Sr. Avenue',
    barangay = NULL, display_label = 'Jose Catolico Avenue',
    latitude = 6.1161459, longitude = 125.1848263,
    aliases = '["Jose Catolico","Jose Catolico Ave","Jose Catolico Sr Avenue","Jose Catolico Sr. Avenue"]', search_keywords = '["jose catolico avenue","jose catolico sr avenue","jose catolico","jose catolico ave","general santos city"]',
    is_verified = 1, is_active = 1, updated_at = NOW()
WHERE osm_type = 'way' AND osm_id = '1287970427';
SET @destination_id = (SELECT id FROM gensan_dispatch_destinations WHERE osm_type = 'way' AND osm_id = '1287970427' ORDER BY id ASC LIMIT 1);
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 1, 'entry', 6.1174587, 125.1861243, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 1
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'entry', latitude = 6.1174587, longitude = 125.1861243
WHERE destination_id = @destination_id AND point_order = 1;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 2, 'geometry', 6.1172421, 125.1859102, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 2
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1172421, longitude = 125.1859102
WHERE destination_id = @destination_id AND point_order = 2;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 3, 'geometry', 6.1171331, 125.1858054, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 3
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1171331, longitude = 125.1858054
WHERE destination_id = @destination_id AND point_order = 3;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 4, 'geometry', 6.1164917, 125.1851671, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 4
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1164917, longitude = 125.1851671
WHERE destination_id = @destination_id AND point_order = 4;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 5, 'geometry', 6.1164451, 125.1851212, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 5
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1164451, longitude = 125.1851212
WHERE destination_id = @destination_id AND point_order = 5;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 6, 'geometry', 6.1159814, 125.1846641, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 6
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1159814, longitude = 125.1846641
WHERE destination_id = @destination_id AND point_order = 6;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 7, 'geometry', 6.1159700, 125.1846530, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 7
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1159700, longitude = 125.1846530
WHERE destination_id = @destination_id AND point_order = 7;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 8, 'geometry', 6.1156029, 125.1842840, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 8
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1156029, longitude = 125.1842840
WHERE destination_id = @destination_id AND point_order = 8;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 9, 'geometry', 6.1155650, 125.1842447, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 9
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1155650, longitude = 125.1842447
WHERE destination_id = @destination_id AND point_order = 9;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 10, 'geometry', 6.1154873, 125.1841649, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 10
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1154873, longitude = 125.1841649
WHERE destination_id = @destination_id AND point_order = 10;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 11, 'geometry', 6.1152406, 125.1839098, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 11
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1152406, longitude = 125.1839098
WHERE destination_id = @destination_id AND point_order = 11;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 12, 'geometry', 6.1151650, 125.1838356, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 12
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1151650, longitude = 125.1838356
WHERE destination_id = @destination_id AND point_order = 12;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 13, 'geometry', 6.1150884, 125.1837605, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 13
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1150884, longitude = 125.1837605
WHERE destination_id = @destination_id AND point_order = 13;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 14, 'geometry', 6.1150019, 125.1836754, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 14
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1150019, longitude = 125.1836754
WHERE destination_id = @destination_id AND point_order = 14;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 15, 'geometry', 6.1149099, 125.1835836, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 15
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1149099, longitude = 125.1835836
WHERE destination_id = @destination_id AND point_order = 15;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 16, 'exit', 6.1148688, 125.1834994, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 16
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'exit', latitude = 6.1148688, longitude = 125.1834994
WHERE destination_id = @destination_id AND point_order = 16;

INSERT INTO gensan_dispatch_destinations (
  destination_type, name, barangay, display_label, latitude, longitude,
  aliases, search_keywords, osm_type, osm_id, is_verified, is_active, created_at, updated_at
)
SELECT 'road_segment', 'Pendatun Avenue', NULL, 'Pendatun Avenue', 6.1148364, 125.1702849, '["Pendatun","Pendatun Ave"]', '["pendatun avenue","pendatun","pendatun ave","general santos city"]', 'way', '791211456', 1, 1, NOW(), NOW()
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM gensan_dispatch_destinations
  WHERE osm_type = 'way' AND osm_id = '791211456'
);
UPDATE gensan_dispatch_destinations
SET destination_type = 'road_segment', name = 'Pendatun Avenue',
    barangay = NULL, display_label = 'Pendatun Avenue',
    latitude = 6.1148364, longitude = 125.1702849,
    aliases = '["Pendatun","Pendatun Ave"]', search_keywords = '["pendatun avenue","pendatun","pendatun ave","general santos city"]',
    is_verified = 1, is_active = 1, updated_at = NOW()
WHERE osm_type = 'way' AND osm_id = '791211456';
SET @destination_id = (SELECT id FROM gensan_dispatch_destinations WHERE osm_type = 'way' AND osm_id = '791211456' ORDER BY id ASC LIMIT 1);
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 1, 'entry', 6.1115535, 125.1716522, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 1
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'entry', latitude = 6.1115535, longitude = 125.1716522
WHERE destination_id = @destination_id AND point_order = 1;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 2, 'geometry', 6.1115722, 125.1715293, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 2
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1115722, longitude = 125.1715293
WHERE destination_id = @destination_id AND point_order = 2;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 3, 'geometry', 6.1116047, 125.1713279, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 3
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1116047, longitude = 125.1713279
WHERE destination_id = @destination_id AND point_order = 3;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 4, 'geometry', 6.1116173, 125.1712910, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 4
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1116173, longitude = 125.1712910
WHERE destination_id = @destination_id AND point_order = 4;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 5, 'geometry', 6.1116307, 125.1712517, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 5
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1116307, longitude = 125.1712517
WHERE destination_id = @destination_id AND point_order = 5;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 6, 'geometry', 6.1117349, 125.1710363, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 6
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1117349, longitude = 125.1710363
WHERE destination_id = @destination_id AND point_order = 6;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 7, 'geometry', 6.1117652, 125.1709925, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 7
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1117652, longitude = 125.1709925
WHERE destination_id = @destination_id AND point_order = 7;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 8, 'geometry', 6.1118417, 125.1708821, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 8
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1118417, longitude = 125.1708821
WHERE destination_id = @destination_id AND point_order = 8;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 9, 'geometry', 6.1119590, 125.1707574, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 9
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1119590, longitude = 125.1707574
WHERE destination_id = @destination_id AND point_order = 9;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 10, 'geometry', 6.1120844, 125.1706414, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 10
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1120844, longitude = 125.1706414
WHERE destination_id = @destination_id AND point_order = 10;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 11, 'geometry', 6.1122271, 125.1705448, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 11
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1122271, longitude = 125.1705448
WHERE destination_id = @destination_id AND point_order = 11;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 12, 'geometry', 6.1123856, 125.1704599, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 12
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1123856, longitude = 125.1704599
WHERE destination_id = @destination_id AND point_order = 12;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 13, 'geometry', 6.1124391, 125.1704349, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 13
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1124391, longitude = 125.1704349
WHERE destination_id = @destination_id AND point_order = 13;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 14, 'geometry', 6.1125531, 125.1703792, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 14
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1125531, longitude = 125.1703792
WHERE destination_id = @destination_id AND point_order = 14;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 15, 'geometry', 6.1125925, 125.1703651, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 15
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1125925, longitude = 125.1703651
WHERE destination_id = @destination_id AND point_order = 15;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 16, 'geometry', 6.1126765, 125.1703352, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 16
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1126765, longitude = 125.1703352
WHERE destination_id = @destination_id AND point_order = 16;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 17, 'geometry', 6.1127840, 125.1703220, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 17
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1127840, longitude = 125.1703220
WHERE destination_id = @destination_id AND point_order = 17;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 18, 'geometry', 6.1135772, 125.1703150, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 18
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1135772, longitude = 125.1703150
WHERE destination_id = @destination_id AND point_order = 18;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 19, 'geometry', 6.1148773, 125.1702839, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 19
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1148773, longitude = 125.1702839
WHERE destination_id = @destination_id AND point_order = 19;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 20, 'geometry', 6.1158480, 125.1702839, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 20
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1158480, longitude = 125.1702839
WHERE destination_id = @destination_id AND point_order = 20;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 21, 'geometry', 6.1163399, 125.1702758, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 21
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1163399, longitude = 125.1702758
WHERE destination_id = @destination_id AND point_order = 21;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 22, 'geometry', 6.1172103, 125.1702889, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 22
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1172103, longitude = 125.1702889
WHERE destination_id = @destination_id AND point_order = 22;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 23, 'geometry', 6.1173188, 125.1702906, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 23
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1173188, longitude = 125.1702906
WHERE destination_id = @destination_id AND point_order = 23;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 24, 'geometry', 6.1173729, 125.1702905, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 24
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1173729, longitude = 125.1702905
WHERE destination_id = @destination_id AND point_order = 24;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 25, 'geometry', 6.1179683, 125.1702891, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 25
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1179683, longitude = 125.1702891
WHERE destination_id = @destination_id AND point_order = 25;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 26, 'geometry', 6.1182963, 125.1702884, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 26
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1182963, longitude = 125.1702884
WHERE destination_id = @destination_id AND point_order = 26;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 27, 'geometry', 6.1184665, 125.1702873, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 27
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1184665, longitude = 125.1702873
WHERE destination_id = @destination_id AND point_order = 27;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 28, 'geometry', 6.1185248, 125.1702872, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 28
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1185248, longitude = 125.1702872
WHERE destination_id = @destination_id AND point_order = 28;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 29, 'geometry', 6.1185363, 125.1702872, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 29
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1185363, longitude = 125.1702872
WHERE destination_id = @destination_id AND point_order = 29;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 30, 'geometry', 6.1185438, 125.1702871, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 30
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1185438, longitude = 125.1702871
WHERE destination_id = @destination_id AND point_order = 30;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 31, 'geometry', 6.1185582, 125.1702871, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 31
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1185582, longitude = 125.1702871
WHERE destination_id = @destination_id AND point_order = 31;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 32, 'geometry', 6.1186977, 125.1702867, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 32
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1186977, longitude = 125.1702867
WHERE destination_id = @destination_id AND point_order = 32;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 33, 'geometry', 6.1187624, 125.1702866, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 33
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1187624, longitude = 125.1702866
WHERE destination_id = @destination_id AND point_order = 33;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 34, 'exit', 6.1188383, 125.1702865, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 34
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'exit', latitude = 6.1188383, longitude = 125.1702865
WHERE destination_id = @destination_id AND point_order = 34;

INSERT INTO gensan_dispatch_destinations (
  destination_type, name, barangay, display_label, latitude, longitude,
  aliases, search_keywords, osm_type, osm_id, is_verified, is_active, created_at, updated_at
)
SELECT 'road_segment', 'Pioneer Avenue', NULL, 'Pioneer Avenue', 6.1093315, 125.1717046, '["Pioneer","Pioneer Ave"]', '["pioneer avenue","pioneer","pioneer ave","general santos city"]', 'way', '153958916', 1, 1, NOW(), NOW()
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM gensan_dispatch_destinations
  WHERE osm_type = 'way' AND osm_id = '153958916'
);
UPDATE gensan_dispatch_destinations
SET destination_type = 'road_segment', name = 'Pioneer Avenue',
    barangay = NULL, display_label = 'Pioneer Avenue',
    latitude = 6.1093315, longitude = 125.1717046,
    aliases = '["Pioneer","Pioneer Ave"]', search_keywords = '["pioneer avenue","pioneer","pioneer ave","general santos city"]',
    is_verified = 1, is_active = 1, updated_at = NOW()
WHERE osm_type = 'way' AND osm_id = '153958916';
SET @destination_id = (SELECT id FROM gensan_dispatch_destinations WHERE osm_type = 'way' AND osm_id = '153958916' ORDER BY id ASC LIMIT 1);
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 1, 'entry', 6.1115535, 125.1716522, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 1
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'entry', latitude = 6.1115535, longitude = 125.1716522
WHERE destination_id = @destination_id AND point_order = 1;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 2, 'geometry', 6.1114176, 125.1716504, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 2
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1114176, longitude = 125.1716504
WHERE destination_id = @destination_id AND point_order = 2;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 3, 'geometry', 6.1113536, 125.1716538, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 3
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1113536, longitude = 125.1716538
WHERE destination_id = @destination_id AND point_order = 3;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 4, 'geometry', 6.1112228, 125.1716574, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 4
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1112228, longitude = 125.1716574
WHERE destination_id = @destination_id AND point_order = 4;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 5, 'geometry', 6.1098814, 125.1716989, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 5
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1098814, longitude = 125.1716989
WHERE destination_id = @destination_id AND point_order = 5;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 6, 'geometry', 6.1095200, 125.1717027, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 6
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1095200, longitude = 125.1717027
WHERE destination_id = @destination_id AND point_order = 6;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 7, 'geometry', 6.1093413, 125.1717045, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 7
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1093413, longitude = 125.1717045
WHERE destination_id = @destination_id AND point_order = 7;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 8, 'geometry', 6.1090800, 125.1717072, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 8
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1090800, longitude = 125.1717072
WHERE destination_id = @destination_id AND point_order = 8;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 9, 'geometry', 6.1077952, 125.1717205, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 9
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1077952, longitude = 125.1717205
WHERE destination_id = @destination_id AND point_order = 9;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 10, 'geometry', 6.1074271, 125.1717241, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 10
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1074271, longitude = 125.1717241
WHERE destination_id = @destination_id AND point_order = 10;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 11, 'geometry', 6.1073772, 125.1717248, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 11
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1073772, longitude = 125.1717248
WHERE destination_id = @destination_id AND point_order = 11;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 12, 'geometry', 6.1072143, 125.1717265, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 12
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'geometry', latitude = 6.1072143, longitude = 125.1717265
WHERE destination_id = @destination_id AND point_order = 12;
INSERT INTO gensan_dispatch_destination_points (
  destination_id, point_order, point_type, latitude, longitude, created_at
)
SELECT @destination_id, 13, 'exit', 6.1071089, 125.1717275, NOW()
FROM DUAL
WHERE @destination_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM gensan_dispatch_destination_points
    WHERE destination_id = @destination_id AND point_order = 13
  );
UPDATE gensan_dispatch_destination_points
SET point_type = 'exit', latitude = 6.1071089, longitude = 125.1717275
WHERE destination_id = @destination_id AND point_order = 13;

COMMIT;
