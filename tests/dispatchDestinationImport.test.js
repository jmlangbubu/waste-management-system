const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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

assert.match(seedSql, /NOT EXISTS/i);
const seedStatements = seedSql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
assert.doesNotMatch(seedStatements, /\b(?:CREATE|ALTER|DROP|DELETE|TRUNCATE)\b/i);
console.log("Dispatch destination import artifact tests passed");
