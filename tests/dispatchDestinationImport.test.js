const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildCatalog,
  buildSeedSql,
  classifyRoadWay,
  normalizeRoadKey,
  reviewBarangayHallCandidate
} = require("../scripts/import-gensan-dispatch-destinations");

const root = path.join(__dirname, "..");
const catalog = JSON.parse(fs.readFileSync(
  path.join(root, "data", "generated", "gensan-dispatch-destinations.json"),
  "utf8"
));
const review = JSON.parse(fs.readFileSync(
  path.join(root, "data", "generated", "gensan-road-segment-review.json"),
  "utf8"
));
const seedSql = fs.readFileSync(
  path.join(root, "database", "generated", "gensan-dispatch-destination-seed.sql"),
  "utf8"
);

const roads = catalog.destinations.filter((destination) => destination.destination_type === "road_segment");
assert.ok(roads.length > 0, "at least one verified road section is required");
roads.forEach((road) => {
  assert.equal(road.is_verified, 1);
  assert.equal(road.is_active, 1);
  assert.equal(road.points[0]?.point_type, "entry");
  assert.equal(road.points.at(-1)?.point_type, "exit");
  assert.ok(road.points.length >= 2);
});
assert.equal(new Set(roads.map((road) => road.segment_key)).size, roads.length);
assert.equal(new Set(roads.map((road) => road.display_label)).size, roads.length);

const unverifiedOsmena = review.road_sections.filter((section) =>
  /osmena/i.test(section.segment_key) && section.verification_status === "unverified"
);
assert.equal(unverifiedOsmena.length, 3);
assert.ok(review.road_sections.every((section) => section.reason));
assert.equal(review.metadata.summary.total_verified_road_records, roads.length);
assert.ok(review.metadata.summary.total_named_drivable_road_components >= roads.length);
assert.ok(Array.isArray(review.metadata.summary.source_osm_way_ids));
assert.ok(Array.isArray(review.metadata.summary.duplicate_road_name_groups));
assert.ok(Array.isArray(review.metadata.summary.disconnected_components));
assert.ok(Array.isArray(review.barangay_hall_candidates));
assert.ok(Array.isArray(review.missing_barangay_halls));

assert.match(seedSql, /NOT EXISTS/i);
const seedStatements = seedSql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
assert.doesNotMatch(seedStatements, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i);
assert.doesNotMatch(seedStatements, /DELETE\s+FROM\s+(?:dispatch_|tracking_)/i);
assert.match(seedStatements, /DELETE FROM gensan_dispatch_destination_points/i);

function way(id, name, highway, nodes, geometry, extraTags = {}) {
  return {
    type: "way",
    id,
    nodes,
    geometry,
    tags: { name, highway, ...extraTags }
  };
}

function testRoadNameNormalization() {
  assert.equal(normalizeRoadKey("Osmeña St."), "osmena street");
  assert.equal(normalizeRoadKey("OSMENA Street"), "osmena street");
  assert.equal(normalizeRoadKey("Pendatun Ave."), "pendatun avenue");
  assert.equal(normalizeRoadKey("Pendatun Avenue"), "pendatun avenue");
}

function testDrivableRoadFiltering() {
  assert.equal(classifyRoadWay(way(1, "Main Road", "primary", [], [])).included, true);
  assert.equal(classifyRoadWay(way(2, "Home Street", "residential", [], [])).included, true);
  assert.equal(classifyRoadWay(way(3, "Public Service", "service", [], [], { access: "yes" })).included, true);
  assert.equal(classifyRoadWay(way(4, "Foot Route", "footway", [], [])).included, false);
  assert.equal(classifyRoadWay(way(5, "Private Road", "residential", [], [], { access: "private" })).included, false);
  assert.equal(classifyRoadWay(way(6, "No Cars", "service", [], [], { motor_vehicle: "no" })).included, false);
  assert.equal(classifyRoadWay(way(7, "House Drive", "service", [], [], { service: "driveway" })).included, false);
}

function testConnectedMergingAndDisconnectedSeparation() {
  const elements = [
    way(101, "Sample Avenue", "primary", [1, 2], [
      { lat: 6.1, lon: 125.1 }, { lat: 6.11, lon: 125.11 }
    ]),
    way(102, "Sample Ave.", "primary", [2, 3], [
      { lat: 6.11, lon: 125.11 }, { lat: 6.12, lon: 125.12 }
    ]),
    way(103, "Sample Avenue", "primary", [9, 10], [
      { lat: 6.2, lon: 125.2 }, { lat: 6.21, lon: 125.21 }
    ]),
    way(201, "Walking Path", "footway", [20, 21], [
      { lat: 6.3, lon: 125.3 }, { lat: 6.31, lon: 125.31 }
    ]),
    way(202, "Private Street", "residential", [30, 31], [
      { lat: 6.4, lon: 125.4 }, { lat: 6.41, lon: 125.41 }
    ], { access: "private" })
  ];
  const result = buildCatalog(elements, []);
  const roads = result.records.filter((record) => record.destination_type === "road_segment");
  assert.equal(roads.length, 2, "disconnected same-name roads must remain separate destinations");
  assert.ok(roads.some((record) => record.source_osm_ids.length === 2));
  assert.ok(roads.some((record) => record.source_osm_ids.length === 1));
  assert.equal(result.summary.excluded_named_highway_ways, 2);
  assert.equal(result.summary.excluded_road_reasons["non_drivable_highway:footway"], 1);
  assert.equal(result.summary.excluded_road_reasons["access:private"], 1);
}

function testGeneratedSeedIdempotency() {
  const sampleRecord = {
    destination_type: "road_segment",
    name: "Sample Avenue",
    barangay: null,
    display_label: "Sample Avenue",
    latitude: 6.1,
    longitude: 125.1,
    aliases: ["Sample Ave"],
    search_keywords: ["sample avenue", "sample ave"],
    osm_type: "way",
    osm_id: "101",
    is_verified: 1,
    is_active: 1,
    points: [
      { point_order: 1, point_type: "entry", latitude: 6.1, longitude: 125.1 },
      { point_order: 2, point_type: "exit", latitude: 6.11, longitude: 125.11 }
    ]
  };
  const sql = buildSeedSql([sampleRecord], "2026-08-02T00:00:00.000Z");
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.match(sql, /UPDATE gensan_dispatch_destinations/);
  assert.match(sql, /destination_id = @destination_id AND point_order = 1/);
  assert.match(sql, /DELETE FROM gensan_dispatch_destination_points\s+WHERE destination_id = @destination_id AND point_order > 2;/);
  assert.doesNotMatch(sql, /DELETE FROM dispatch_|DELETE FROM tracking_/);
}

function testReviewedPinnedRoadSurvivesAmbiguousSameNameNetwork() {
  const elements = [
    way(301, "Reviewed Avenue", "primary", [1, 2], [
      { lat: 6.1, lon: 125.1 }, { lat: 6.11, lon: 125.11 }
    ]),
    way(302, "Reviewed Avenue", "primary", [2, 3], [
      { lat: 6.11, lon: 125.11 }, { lat: 6.12, lon: 125.12 }
    ]),
    way(303, "Reviewed Avenue", "primary", [2, 4], [
      { lat: 6.11, lon: 125.11 }, { lat: 6.13, lon: 125.13 }
    ])
  ];
  const definitions = [{
    segment_key: "reviewed-avenue",
    display_label: "Reviewed Avenue",
    official_road_name: "Reviewed Avenue",
    barangay: null,
    aliases: ["Reviewed Ave"],
    source_osm_way_ids: [301],
    start_reference: null,
    verification_notes: "Pinned and reviewed.",
    is_verified: true
  }];
  const result = buildCatalog(elements, definitions);
  const pinned = result.records.find((record) => record.segment_key === "reviewed-avenue");
  assert.ok(pinned, "a reviewed pinned way must survive a branched same-name OSM component");
  assert.equal(pinned.osm_id, "301");
  assert.deepEqual(pinned.source_osm_ids, ["301"]);
}

function testBarangayHallCandidateReporting() {
  const verified = reviewBarangayHallCandidate({
    type: "node",
    id: 501,
    lat: 6.1,
    lon: 125.1,
    tags: {
      name: "Barangay Hall of Lagao",
      amenity: "townhall",
      "addr:barangay": "Lagao"
    }
  });
  assert.ok(verified.record);
  assert.equal(verified.review.verification_status, "verified");

  const verifiedWay = reviewBarangayHallCandidate({
    type: "way",
    id: 503,
    geometry: [
      { lat: 6.2, lon: 125.2 },
      { lat: 6.2, lon: 125.21 },
      { lat: 6.21, lon: 125.21 },
      { lat: 6.21, lon: 125.2 },
      { lat: 6.2, lon: 125.2 }
    ],
    tags: { name: "Lagao Barangay Hall", amenity: "townhall" }
  });
  assert.ok(verifiedWay.record, "verified OSM building geometry must provide a hall anchor");
  assert.equal(verifiedWay.record.barangay, "Lagao");

  const officialLabel = reviewBarangayHallCandidate({
    type: "node",
    id: 504,
    lat: 6.3,
    lon: 125.3,
    tags: {
      name: "Sangguniang Pambarangay ng Dadiangas East",
      office: "government"
    }
  });
  assert.ok(officialLabel.record);
  assert.equal(officialLabel.record.barangay, "Dadiangas East");

  const unverified = reviewBarangayHallCandidate({
    type: "node",
    id: 502,
    lat: 6.2,
    lon: 125.2,
    tags: { name: "Barangay Hall", amenity: "townhall" }
  });
  assert.equal(unverified.record, null);
  assert.equal(unverified.review.verification_status, "unverified");
  assert.match(unverified.review.reason, /official General Santos barangay/);
}

testRoadNameNormalization();
testDrivableRoadFiltering();
testConnectedMergingAndDisconnectedSeparation();
testGeneratedSeedIdempotency();
testReviewedPinnedRoadSurvivesAmbiguousSameNameNetwork();
testBarangayHallCandidateReporting();
console.log("Dispatch destination import artifact tests passed");
