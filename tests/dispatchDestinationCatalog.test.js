const assert = require("node:assert/strict");
const Module = require("node:module");

const originalModuleLoad = Module._load;
Module._load = function loadWithMockedDispatchPool(request, parent, isMain) {
  if (
    request === "../config/dbPromise" &&
    parent &&
    parent.filename.replace(/\\/g, "/").endsWith("services/dispatchService.js")
  ) {
    return {};
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const {
  DispatchService,
  destinationLimit,
  isDestinationCatalogTableMissingError,
  normalizeDestinationSearchText
} = require("../services/dispatchService");
Module._load = originalModuleLoad;

function createPool(resolver) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(sql, parameters) {
        const normalizedSql = sql.replace(/\s+/g, " ").trim();
        calls.push({ sql: normalizedSql, parameters });
        return resolver(normalizedSql, parameters, calls.length - 1);
      }
    }
  };
}

async function testDestinationTypeValidation() {
  const service = new DispatchService({ query: async () => [[], []] });
  await assert.rejects(
    () => service.listDestinations({ type: "landmark" }),
    (error) => error.code === "INVALID_DESTINATION_TYPE" && error.statusCode === 400
  );
}

async function testRoadSearchAndCatalogRules() {
  const { pool, calls } = createPool(async () => [[{
    id: 12,
    destination_type: "road_segment",
    name: "Pendatun Avenue",
    barangay: null,
    display_label: "Pendatun Avenue",
    latitude: "6.116",
    longitude: "125.171",
    aliases: '["Pendatun","Pendatun Ave"]',
    is_verified: 1,
    has_geometry: 1,
    geometry_point_count: "6"
  }], []]);
  const result = await new DispatchService(pool).listDestinations({
    type: "road_segment",
    q: "  PENDATUN!!  ",
    limit: 10
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Pendatun Avenue");
  assert.equal(result[0].destination_type, "road_segment");
  assert.equal(result[0].is_verified, true);
  assert.equal(result[0].has_geometry, true);
  assert.equal(result[0].geometry_point_count, 6);
  assert.match(calls[0].sql, /gdd\.destination_type IN \('road_segment', 'road'\)/);
  assert.match(calls[0].sql, /gdd\.is_active = 1/);
  assert.match(calls[0].sql, /gdd\.is_verified = 1/);
  assert.match(calls[0].sql, /CONCAT_WS\(' ', .*gdd\.aliases/i);
  assert.match(calls[0].sql, /utf8mb4_unicode_ci/i);
  assert.match(calls[0].sql, /CASE WHEN .*gdd\.display_label.* = \?.*gdd\.name.* = \? THEN 0/i);
  assert.deepEqual(calls[0].parameters, [
    "%pendatun%",
    "pendatun",
    "pendatun",
    "pendatun%",
    "pendatun%",
    10
  ]);
}

async function testBarangayHallSearch() {
  const { pool, calls } = createPool(async () => [[], []]);
  await new DispatchService(pool).listDestinations({
    type: "barangay_hall",
    barangay: "  LAGAO ",
    limit: 999
  });
  assert.match(calls[0].sql, /gdd\.barangay.* = \?/i);
  assert.deepEqual(calls[0].parameters, ["barangay_hall", "lagao", 999]);
}

function testAccentNormalizationAndLimits() {
  assert.equal(normalizeDestinationSearchText("  Osme\u00f1a St. "), "osmena st");
  assert.equal(normalizeDestinationSearchText("South-Osme\u00f1a!!!"), "south osmena");
  assert.equal(normalizeDestinationSearchText("OSMENA"), "osmena");
  assert.equal(destinationLimit(undefined), 20);
  assert.equal(destinationLimit("0"), 20);
  assert.equal(destinationLimit("10"), 10);
  assert.equal(destinationLimit("5000"), 1000);
}

async function testOrderedDestinationPointRetrieval() {
  const pointRows = [
    { id: 20, destination_id: 7, point_order: 1, point_type: "entry", latitude: "6.10", longitude: "125.10" },
    { id: 21, destination_id: 7, point_order: 2, point_type: "geometry", latitude: "6.11", longitude: "125.11" },
    { id: 22, destination_id: 7, point_order: 3, point_type: "exit", latitude: "6.12", longitude: "125.12" }
  ];
  const { pool, calls } = createPool(async (sql) => {
    if (sql.includes("FROM gensan_dispatch_destinations")) {
      return [[{
        id: 7,
        destination_type: "road_segment",
        name: "Pioneer Avenue",
        barangay: null,
        display_label: "Pioneer Avenue, General Santos City",
        latitude: "6.10",
        longitude: "125.10",
        is_verified: 1,
        is_active: 1
      }], []];
    }
    return [pointRows, []];
  });
  const detail = await new DispatchService(pool).getDestination(7);
  const pointsCall = calls.find((call) => call.sql.includes("gensan_dispatch_destination_points"));
  const destinationCall = calls.find((call) => call.sql.includes("FROM gensan_dispatch_destinations"));
  assert.match(pointsCall.sql, /ORDER BY point_order ASC, id ASC/);
  assert.match(destinationCall.sql, /is_verified = 1/);
  assert.deepEqual(detail.points.map((point) => point.point_order), [1, 2, 3]);
  assert.equal(detail.points[0].point_type, "entry");
  assert.equal(detail.points.at(-1).point_type, "exit");
  assert.equal(detail.has_geometry, true);
  assert.equal(detail.geometry_point_count, 3);
}

async function testMissingTableControlledResponse() {
  const missingTableError = Object.assign(
    new Error("Table 'railway.gensan_dispatch_destinations' doesn't exist"),
    { code: "ER_NO_SUCH_TABLE" }
  );
  const service = new DispatchService({
    async query() {
      throw missingTableError;
    }
  });
  assert.equal(isDestinationCatalogTableMissingError(missingTableError), true);
  await assert.rejects(
    () => service.listDestinations({ type: "road_segment" }),
    (error) =>
      error.code === "DISPATCH_DESTINATION_CATALOG_SETUP_REQUIRED" &&
      error.statusCode === 503
  );
}

async function run() {
  await testDestinationTypeValidation();
  await testRoadSearchAndCatalogRules();
  await testBarangayHallSearch();
  testAccentNormalizationAndLimits();
  await testOrderedDestinationPointRetrieval();
  await testMissingTableControlledResponse();
  console.log("Dispatch destination catalog mock tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
