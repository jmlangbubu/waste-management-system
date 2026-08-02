#!/usr/bin/env node

const fs = require("fs");
const https = require("https");
const path = require("path");

const OVERPASS_URLS = Object.freeze([
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
]);
const JSON_OUTPUT = path.join(
  __dirname,
  "..",
  "data",
  "generated",
  "gensan-dispatch-destinations.json"
);
const SQL_OUTPUT = path.join(
  __dirname,
  "..",
  "database",
  "generated",
  "gensan-dispatch-destination-seed.sql"
);
const REVIEW_OUTPUT = path.join(
  __dirname,
  "..",
  "data",
  "generated",
  "gensan-road-segment-review.json"
);
const ROAD_DEFINITIONS_PATH = path.join(
  __dirname,
  "..",
  "data",
  "gensan-road-segment-definitions.json"
);
const OFFICIAL_BARANGAYS = Object.freeze([
  "Apopong", "Baluan", "Batomelong", "Buayan", "Bula", "Calumpang",
  "City Heights", "Conel", "Dadiangas East", "Dadiangas North",
  "Dadiangas South", "Dadiangas West", "Fatima", "Katangawan",
  "Labangal", "Lagao", "Ligaya", "Mabuhay", "Olympog", "San Isidro",
  "San Jose", "Siguel", "Sinawal", "Tambler", "Tinagacan", "Upper Labay"
]);
const DRIVABLE_HIGHWAY_CLASSES = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary",
  "primary_link", "secondary", "secondary_link", "tertiary",
  "tertiary_link", "residential", "unclassified", "living_street", "service"
]);
const NON_PUBLIC_ACCESS_VALUES = new Set(["no", "private"]);
const NON_DRIVABLE_SERVICE_TYPES = new Set([
  "driveway", "parking_aisle", "drive-through", "emergency_access"
]);

const OVERPASS_QUERY = `
[out:json][timeout:180];
area["boundary"="administrative"]["name"~"^General Santos( City)?$",i]->.gensan;
(
  way(area.gensan)["highway"]["name"];
  nwr(area.gensan)["amenity"="townhall"]["name"~"barangay|brgy",i];
  nwr(area.gensan)["office"="government"]["name"~"barangay|brgy",i];
  nwr(area.gensan)["government"="administrative"]["name"~"barangay|brgy",i];
);
out body center geom;
`.trim();

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bbarangay\b|\bbrgy\.?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const BARANGAY_BY_KEY = new Map(
  OFFICIAL_BARANGAYS.map((barangay) => [normalizeSearchText(barangay), barangay])
);

function canonicalBarangay(tags = {}, name = "") {
  const candidates = [
    tags["addr:barangay"],
    tags["addr:suburb"],
    tags["addr:district"],
    tags["is_in:barangay"],
    name
  ];
  for (const candidate of candidates) {
    const normalized = normalizeSearchText(candidate);
    if (!normalized) continue;
    if (BARANGAY_BY_KEY.has(normalized)) return BARANGAY_BY_KEY.get(normalized);
    const barangayMatches = [...BARANGAY_BY_KEY.entries()].sort(
      ([first], [second]) => second.length - first.length
    );
    for (const [key, barangay] of barangayMatches) {
      const words = ` ${normalized} `;
      if (words.includes(` ${key} `)) return barangay;
    }
  }
  return "";
}

function normalizeRoadName(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRoadKey(value) {
  return normalizeSearchText(value)
    .replace(/\b(?:street|st)\b/g, "street")
    .replace(/\b(?:avenue|ave)\b/g, "avenue")
    .replace(/\b(?:boulevard|blvd)\b/g, "boulevard")
    .replace(/\b(?:road|rd)\b/g, "road")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasesForName(name) {
  const aliases = new Set();
  const asciiName = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (asciiName !== name) aliases.add(asciiName);
  if (/osme[nñ]a/i.test(name)) {
    aliases.add(name.replace(/osmeña/gi, "Osmena"));
    aliases.add(name.replace(/osmena/gi, "Osmeña"));
  }
  const suffixAliases = [
    [/\bStreet\b/gi, "St"],
    [/\bAvenue\b/gi, "Ave"],
    [/\bBoulevard\b/gi, "Blvd"],
    [/\bRoad\b/gi, "Rd"]
  ];
  for (const [pattern, replacement] of suffixAliases) {
    if (pattern.test(name)) aliases.add(name.replace(pattern, replacement));
    pattern.lastIndex = 0;
  }
  aliases.delete(name);
  return [...aliases].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

function classifyRoadWay(element) {
  const tags = element?.tags || {};
  const name = normalizeRoadName(tags.name);
  const highway = String(tags.highway || "").toLowerCase();
  if (!name) return { included: false, reason: "unnamed" };
  if (!DRIVABLE_HIGHWAY_CLASSES.has(highway)) {
    return { included: false, reason: `non_drivable_highway:${highway || "missing"}` };
  }
  if (String(tags.area || "").toLowerCase() === "yes") {
    return { included: false, reason: "highway_area" };
  }
  if (tags.construction || highway === "construction") {
    return { included: false, reason: "construction" };
  }
  for (const key of ["access", "vehicle", "motor_vehicle", "motorcar"]) {
    const value = String(tags[key] || "").toLowerCase();
    if (NON_PUBLIC_ACCESS_VALUES.has(value)) {
      return { included: false, reason: `${key}:${value}` };
    }
  }
  if (
    highway === "service" &&
    NON_DRIVABLE_SERVICE_TYPES.has(String(tags.service || "").toLowerCase())
  ) {
    return { included: false, reason: `service:${String(tags.service).toLowerCase()}` };
  }
  return { included: true, reason: "named_drivable" };
}

function radians(value) {
  return (Number(value) * Math.PI) / 180;
}

function distanceMeters(first, second) {
  const earthRadius = 6371000;
  const latitudeDelta = radians(second.lat - first.lat);
  const longitudeDelta = radians(second.lon - first.lon);
  const latitudeA = radians(first.lat);
  const latitudeB = radians(second.lat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(haversine));
}

function geometryAnchor(geometry) {
  if (!geometry.length) return null;
  if (geometry.length === 1) return geometry[0];
  const lengths = [];
  let total = 0;
  for (let index = 1; index < geometry.length; index += 1) {
    const segment = distanceMeters(geometry[index - 1], geometry[index]);
    lengths.push(segment);
    total += segment;
  }
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    if (remaining <= lengths[index]) {
      const ratio = lengths[index] ? remaining / lengths[index] : 0;
      return {
        lat: geometry[index].lat + (geometry[index + 1].lat - geometry[index].lat) * ratio,
        lon: geometry[index].lon + (geometry[index + 1].lon - geometry[index].lon) * ratio
      };
    }
    remaining -= lengths[index];
  }
  return geometry[geometry.length - 1];
}

function validPoint(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function isBarangayHall(element) {
  const name = String(element.tags?.name || "");
  const tags = element.tags || {};
  const namesBarangay = /\bbarangay\b|\bbrgy\.?|pambarangay|sangguniang/i.test(name);
  const hallMeaning =
    /\b(hall|office)\b/i.test(name) ||
    tags.amenity === "townhall" ||
    tags.office === "government" ||
    tags.government === "administrative";
  return namesBarangay && hallMeaning;
}

function elementKey(element) {
  return `${element.type}/${element.id}`;
}

function hallPoint(element) {
  if (validPoint(element)) return { lat: Number(element.lat), lon: Number(element.lon) };
  if (validPoint(element?.center)) {
    return { lat: Number(element.center.lat), lon: Number(element.center.lon) };
  }
  const geometry = (Array.isArray(element?.geometry) ? element.geometry : [])
    .filter(validPoint);
  if (!geometry.length) return null;
  return {
    lat: geometry.reduce((total, point) => total + Number(point.lat), 0) / geometry.length,
    lon: geometry.reduce((total, point) => total + Number(point.lon), 0) / geometry.length
  };
}

function hallRecord(element) {
  if (!isBarangayHall(element)) return null;
  const name = normalizeRoadName(element.tags?.name);
  const barangay = canonicalBarangay(element.tags, name);
  const point = hallPoint(element);
  if (!name || !barangay || !validPoint(point)) return null;
  const aliases = aliasesForName(name);
  return {
    destination_type: "barangay_hall",
    name,
    barangay,
    display_label: `${name}, ${barangay}`,
    latitude: Number(point.lat),
    longitude: Number(point.lon),
    aliases,
    search_keywords: [...new Set([name, ...aliases, barangay, "barangay hall", "General Santos City"].map(normalizeSearchText).filter(Boolean))],
    osm_type: element.type,
    osm_id: String(element.id),
    is_verified: 1,
    is_active: 1,
    points: [{
      point_order: 1,
      point_type: "anchor",
      latitude: Number(point.lat),
      longitude: Number(point.lon)
    }]
  };
}

function reviewBarangayHallCandidate(element) {
  const tags = element?.tags || {};
  const name = normalizeRoadName(tags.name);
  const barangay = canonicalBarangay(tags, name);
  const point = hallPoint(element);
  const record = hallRecord(element);
  let reason = "Verified OpenStreetMap barangay-hall record with an official barangay name and usable coordinate.";
  if (!isBarangayHall(element)) {
    reason = "The OpenStreetMap feature does not clearly identify an actual barangay hall or office.";
  } else if (!barangay) {
    reason = "The OpenStreetMap name/address could not be matched to an official General Santos barangay.";
  } else if (!validPoint(point)) {
    reason = "The OpenStreetMap feature has no usable point or center coordinate.";
  }
  return {
    record,
    review: {
      osm_type: element?.type || null,
      osm_id: element?.id === undefined ? null : String(element.id),
      name: name || null,
      barangay: barangay || null,
      coordinate: validPoint(point)
        ? { latitude: Number(point.lat), longitude: Number(point.lon) }
        : null,
      source_tags: {
        amenity: tags.amenity || null,
        office: tags.office || null,
        government: tags.government || null,
        addr_barangay: tags["addr:barangay"] || null
      },
      verification_status: record ? "verified" : "unverified",
      reason
    }
  };
}

function wayDescriptor(element) {
  const geometry = Array.isArray(element.geometry)
    ? element.geometry
        .filter(validPoint)
        .map((point) => ({ lat: Number(point.lat), lon: Number(point.lon) }))
    : [];
  const suppliedNodes = Array.isArray(element.nodes) ? element.nodes : [];
  const nodes = geometry.map((point, index) =>
    suppliedNodes[index] === undefined
      ? `${point.lat.toFixed(7)},${point.lon.toFixed(7)}`
      : String(suppliedNodes[index])
  );
  return {
    element,
    id: String(element.id),
    name: normalizeRoadName(element.tags?.name),
    geometry,
    nodes,
    start: nodes[0] || "",
    end: nodes[nodes.length - 1] || ""
  };
}

function connectedWayGroups(ways) {
  const nodeToWays = new Map();
  ways.forEach((way, index) => {
    new Set(way.nodes).forEach((node) => {
      if (!nodeToWays.has(node)) nodeToWays.set(node, []);
      nodeToWays.get(node).push(index);
    });
  });
  const remaining = new Set(ways.map((_, index) => index));
  const components = [];
  while (remaining.size) {
    const seed = remaining.values().next().value;
    const queue = [seed];
    const component = [];
    remaining.delete(seed);
    while (queue.length) {
      const index = queue.shift();
      const way = ways[index];
      component.push(way);
      new Set(way.nodes).forEach((node) => {
        (nodeToWays.get(node) || []).forEach((neighbor) => {
          if (remaining.delete(neighbor)) queue.push(neighbor);
        });
      });
    }
    components.push(component.sort((first, second) => first.id.localeCompare(second.id, "en", { numeric: true })));
  }
  return components.sort((first, second) =>
    first[0].id.localeCompare(second[0].id, "en", { numeric: true })
  );
}

function connectedWayComponents(ways) {
  return connectedWayGroups(ways).map((component) => component.map((way) => way.id));
}

function orderConnectedWayGeometry(elements, startReference = null) {
  const ways = elements.map(wayDescriptor).filter((way) => way.geometry.length >= 2);
  const components = connectedWayComponents(ways);
  if (!ways.length) {
    return { verified: false, reason: "No complete OSM way geometry was available.", geometry: [], components };
  }
  if (components.length !== 1) {
    return {
      verified: false,
      reason: `Matched OSM ways form ${components.length} disconnected geometry components.`,
      geometry: [],
      components
    };
  }

  const endpointToWays = new Map();
  ways.forEach((way, index) => {
    new Set([way.start, way.end]).forEach((endpoint) => {
      if (!endpointToWays.has(endpoint)) endpointToWays.set(endpoint, []);
      endpointToWays.get(endpoint).push(index);
    });
  });
  const branches = [...endpointToWays.entries()].filter(([, indexes]) => indexes.length > 2);
  if (branches.length) {
    return {
      verified: false,
      reason: "Matched OSM ways contain a branched endpoint and do not define one unambiguous section.",
      geometry: [],
      components
    };
  }
  const endpoints = [...endpointToWays.entries()]
    .filter(([, indexes]) => indexes.length === 1)
    .map(([endpoint]) => endpoint);
  const isLoop = endpoints.length === 0 && [...endpointToWays.values()].every((indexes) => indexes.length === 2);
  if (endpoints.length !== 2 && !isLoop) {
    return {
      verified: false,
      reason: "Matched OSM ways do not expose one unambiguous path or closed loop.",
      geometry: [],
      components
    };
  }

  const requestedStart = String(startReference?.osm_node_id || "");
  let currentEndpoint = endpoints.includes(requestedStart)
    ? requestedStart
    : isLoop
      ? [...endpointToWays.keys()].sort()[0]
      : [...endpoints].sort()[0];
  const unused = new Set(ways.map((_, index) => index));
  const orderedWayIds = [];
  const geometry = [];
  while (unused.size) {
    const matches = (endpointToWays.get(currentEndpoint) || []).filter((index) => unused.has(index));
    const usableMatches = [...new Set(matches)].sort((first, second) =>
      ways[first].id.localeCompare(ways[second].id, "en", { numeric: true })
    );
    if (!usableMatches.length || (geometry.length && usableMatches.length !== 1)) {
      return {
        verified: false,
        reason: "OSM way ordering became ambiguous while traversing the requested section.",
        geometry: [],
        components
      };
    }
    const index = usableMatches[0];
    const way = ways[index];
    const forward = way.start === currentEndpoint;
    const orderedGeometry = forward ? way.geometry : [...way.geometry].reverse();
    geometry.push(...(geometry.length ? orderedGeometry.slice(1) : orderedGeometry));
    orderedWayIds.push(way.id);
    unused.delete(index);
    currentEndpoint = forward ? way.end : way.start;
  }

  return {
    verified: true,
    reason: isLoop
      ? "Named OSM ways form one connected, unbranched closed loop."
      : "Named OSM ways form one connected, unbranched section with two endpoints.",
    geometry,
    ordered_way_ids: orderedWayIds,
    entry_node_id: endpoints.includes(requestedStart)
      ? requestedStart
      : isLoop
        ? geometry.length ? ways.find((way) => way.id === orderedWayIds[0])?.start || null : null
        : [...endpoints].sort()[0],
    exit_node_id: currentEndpoint,
    components
  };
}

function evaluateRoadDefinition(definition, roadWays) {
  const officialName = normalizeRoadName(definition.official_road_name);
  const matchingWays = roadWays.filter(
    (element) => normalizeSearchText(element.tags?.name) === normalizeSearchText(officialName)
  );
  const matchingById = new Map(matchingWays.map((element) => [String(element.id), element]));
  const pinnedIds = (definition.source_osm_way_ids || []).map(String);
  const missingPinnedIds = pinnedIds.filter((id) => !matchingById.has(id));
  const selectedWays = pinnedIds.length
    ? pinnedIds.map((id) => matchingById.get(id)).filter(Boolean)
    : matchingWays;
  const ordered = orderConnectedWayGeometry(selectedWays, definition.start_reference);
  const candidatePointCount = selectedWays.reduce(
    (total, element) => total + (Array.isArray(element.geometry) ? element.geometry.length : 0),
    0
  );
  let reason = ordered.reason;
  let verified = Boolean(definition.is_verified && ordered.verified && !missingPinnedIds.length);
  if (!definition.is_verified) reason = definition.verification_notes || "Definition requires manual verification.";
  else if (missingPinnedIds.length) {
    reason = `Pinned OSM way IDs were not returned for the named road: ${missingPinnedIds.join(", ")}.`;
    verified = false;
  }

  const geometry = ordered.geometry || [];
  const matchedIds = selectedWays.map((element) => String(element.id));
  const unmatchedCandidateIds = matchingWays
    .map((element) => String(element.id))
    .filter((id) => !matchedIds.includes(id));
  const review = {
    segment_key: definition.segment_key,
    requested_road_section: definition.display_label,
    official_road_name: officialName,
    matched_osm_road_name: matchingWays[0]?.tags?.name || null,
    matched_osm_ids: matchedIds,
    ordered_osm_ids: ordered.ordered_way_ids || [],
    barangay: definition.barangay || null,
    geometry_point_count: geometry.length || candidatePointCount,
    entry_coordinate: geometry.length
      ? { latitude: geometry[0].lat, longitude: geometry[0].lon }
      : null,
    exit_coordinate: geometry.length
      ? { latitude: geometry[geometry.length - 1].lat, longitude: geometry[geometry.length - 1].lon }
      : null,
    verification_status: verified ? "verified" : "unverified",
    reason,
    possible_duplicate_or_ambiguous_matches: {
      unselected_matching_osm_ids: unmatchedCandidateIds,
      connected_components: ordered.components || [],
      selected_way_details: selectedWays.map((element) => ({
        osm_id: String(element.id),
        geometry_point_count: Array.isArray(element.geometry) ? element.geometry.length : 0,
        start_node_id: Array.isArray(element.nodes) && element.nodes.length ? String(element.nodes[0]) : null,
        end_node_id: Array.isArray(element.nodes) && element.nodes.length
          ? String(element.nodes[element.nodes.length - 1])
          : null
      }))
    }
  };
  if (!verified) return { record: null, review };

  const anchor = geometryAnchor(geometry);
  const aliases = [...new Set([
    ...(definition.aliases || []),
    officialName,
    ...aliasesForName(definition.display_label)
  ])].filter((alias) => alias && alias !== definition.display_label);
  const record = {
    segment_key: definition.segment_key,
    destination_type: "road_segment",
    name: officialName,
    barangay: definition.barangay || null,
    display_label: definition.display_label,
    latitude: anchor.lat,
    longitude: anchor.lon,
    aliases,
    search_keywords: [...new Set([
      definition.display_label,
      officialName,
      definition.segment_key,
      ...(definition.aliases || []),
      definition.barangay,
      "General Santos City"
    ].map(normalizeSearchText).filter(Boolean))],
    osm_type: "way",
    osm_id: matchedIds[0],
    source_osm_ids: matchedIds,
    is_verified: 1,
    is_active: 1,
    points: geometryPointRecords(geometry)
  };
  return { record, review };
}

function commonComponentBarangay(ways) {
  const barangays = new Set(
    ways
      .map((way) => canonicalBarangay(way.element.tags, way.name))
      .filter(Boolean)
  );
  return barangays.size === 1 ? [...barangays][0] : "";
}

function preferredComponentRoadName(ways) {
  const counts = new Map();
  ways.forEach((way) => {
    const name = normalizeRoadName(way.name);
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  });
  return [...counts.entries()]
    .sort(([firstName, firstCount], [secondName, secondCount]) =>
      secondCount - firstCount ||
      Number(/[^\x00-\x7F]/.test(secondName)) - Number(/[^\x00-\x7F]/.test(firstName)) ||
      firstName.localeCompare(secondName, "en", { sensitivity: "base" })
    )[0]?.[0] || "";
}

function matchingVerifiedDefinition(definitions, componentWays, normalizedName) {
  const componentIds = new Set(componentWays.map((way) => way.id));
  return definitions.find((definition) => {
    if (!definition.is_verified) return false;
    if (normalizeRoadKey(definition.official_road_name) !== normalizedName) return false;
    const pinnedIds = (definition.source_osm_way_ids || []).map(String);
    return pinnedIds.length > 0 && pinnedIds.every((id) => componentIds.has(id));
  }) || null;
}

function geometryPointRecords(geometry) {
  if (!geometry.length) return [];
  let middleIndex = -1;
  if (geometry.length > 2) {
    const anchor = geometryAnchor(geometry);
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < geometry.length - 1; index += 1) {
      const distance = distanceMeters(geometry[index], anchor);
      if (distance < closestDistance) {
        closestDistance = distance;
        middleIndex = index;
      }
    }
  }
  return geometry.map((point, index) => ({
    point_order: index + 1,
    point_type:
      index === 0
        ? "entry"
        : index === geometry.length - 1
          ? "exit"
          : index === middleIndex
            ? "middle"
            : "geometry",
    latitude: point.lat,
    longitude: point.lon
  }));
}

function buildAutomatedRoadCatalog(roadWays, definitions = []) {
  const groupedByName = new Map();
  roadWays.forEach((element) => {
    const descriptor = wayDescriptor(element);
    const key = normalizeRoadKey(descriptor.name);
    if (!groupedByName.has(key)) groupedByName.set(key, []);
    groupedByName.get(key).push(descriptor);
  });

  const records = [];
  const reviews = [];
  const matchedDefinitionKeys = new Set();
  [...groupedByName.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .forEach(([normalizedName, namedWays]) => {
      const components = connectedWayGroups(namedWays);
      components.forEach((componentWays, componentIndex) => {
        const elements = componentWays.map((way) => way.element);
        const ordered = orderConnectedWayGeometry(elements);
        const matchedDefinition = matchingVerifiedDefinition(
          definitions,
          componentWays,
          normalizedName
        );
        const definition = ordered.verified ? matchedDefinition : null;
        if (definition) matchedDefinitionKeys.add(definition.segment_key);
        const sourceIds = componentWays
          .map((way) => way.id)
          .sort((first, second) => first.localeCompare(second, "en", { numeric: true }));
        const orderedIds = ordered.ordered_way_ids || [];
        const primaryOsmId = definition
          ? String(definition.source_osm_way_ids[0])
          : sourceIds[0];
        const canonicalName = definition?.official_road_name || preferredComponentRoadName(componentWays);
        const barangay = definition?.barangay || commonComponentBarangay(componentWays) || null;
        const componentLabel = components.length === 1
          ? canonicalName
          : `${canonicalName} — ${barangay ? `${barangay} Section ${componentIndex + 1}` : `Section ${componentIndex + 1}`}`;
        const displayLabel = definition?.display_label || componentLabel;
        const segmentKey = definition?.segment_key || `${normalizedName.replace(/\s+/g, "-")}-${primaryOsmId}`;
        const review = {
          segment_key: segmentKey,
          requested_road_section: displayLabel,
          official_road_name: canonicalName,
          matched_osm_road_name: preferredComponentRoadName(componentWays),
          matched_osm_ids: sourceIds,
          ordered_osm_ids: orderedIds,
          source_osm_way_ids: sourceIds,
          source_highway_classes: [...new Set(componentWays.map((way) => way.element.tags?.highway).filter(Boolean))].sort(),
          barangay,
          normalized_road_key: normalizedName,
          connected_component_index: componentIndex + 1,
          connected_component_count: components.length,
          geometry_point_count: ordered.geometry?.length || 0,
          entry_coordinate: ordered.geometry?.length
            ? { latitude: ordered.geometry[0].lat, longitude: ordered.geometry[0].lon }
            : null,
          exit_coordinate: ordered.geometry?.length
            ? {
                latitude: ordered.geometry[ordered.geometry.length - 1].lat,
                longitude: ordered.geometry[ordered.geometry.length - 1].lon
              }
            : null,
          verification_status: ordered.verified ? "verified" : "unverified",
          reason: ordered.verified
            ? "All source ways are named, drivable, connected, and form one unambiguous path or loop."
            : ordered.reason,
          possible_duplicate_or_ambiguous_matches: {
            connected_components: components.map((component) => component.map((way) => way.id)),
            selected_way_details: componentWays.map((way) => ({
              osm_id: way.id,
              geometry_point_count: way.geometry.length,
              start_node_id: way.start || null,
              end_node_id: way.end || null
            }))
          }
        };
        reviews.push(review);
        if (!ordered.verified || !ordered.geometry?.length) return;

        const sourceNames = [...new Set(componentWays.map((way) => way.name).filter(Boolean))];
        const aliases = [...new Set([
          ...(definition?.aliases || []),
          ...sourceNames,
          ...sourceNames.flatMap(aliasesForName),
          ...aliasesForName(displayLabel)
        ])]
          .filter((alias) => alias && alias !== displayLabel)
          .sort((first, second) => first.localeCompare(second, "en", { sensitivity: "base" }));
        const anchor = geometryAnchor(ordered.geometry);
        records.push({
          segment_key: segmentKey,
          destination_type: "road_segment",
          name: normalizeRoadName(canonicalName),
          barangay,
          display_label: displayLabel,
          latitude: anchor.lat,
          longitude: anchor.lon,
          aliases,
          search_keywords: [...new Set([
            displayLabel,
            canonicalName,
            segmentKey,
            ...aliases,
            barangay,
            "General Santos City"
          ].map(normalizeSearchText).filter(Boolean))],
          osm_type: "way",
          osm_id: primaryOsmId,
          source_osm_ids: sourceIds,
          is_verified: 1,
          is_active: 1,
          points: geometryPointRecords(ordered.geometry)
        });
      });
    });

  return { records, reviews, matchedDefinitionKeys };
}

function buildCatalog(elements, definitions = [], options = {}) {
  const uniqueElements = new Map();
  let duplicateObjects = 0;
  for (const element of elements) {
    const key = elementKey(element);
    if (uniqueElements.has(key)) duplicateObjects += 1;
    uniqueElements.set(key, element);
  }

  const roadWays = [];
  const roadExclusions = [];
  const hallRecords = [];
  const hallCandidateReviews = [];
  let roadsWithoutGeometry = 0;
  let rejectedHallCandidates = 0;
  for (const element of uniqueElements.values()) {
    if (element.type === "way" && element.tags?.highway && element.tags?.name) {
      const descriptor = wayDescriptor(element);
      const classification = classifyRoadWay(element);
      if (descriptor.geometry.length < 2) {
        roadsWithoutGeometry += 1;
        roadExclusions.push({
          osm_id: String(element.id),
          name: normalizeRoadName(element.tags.name),
          highway: element.tags.highway,
          reason: "missing_complete_geometry"
        });
      } else if (classification.included) {
        roadWays.push(element);
      } else {
        roadExclusions.push({
          osm_id: String(element.id),
          name: normalizeRoadName(element.tags.name),
          highway: element.tags.highway,
          reason: classification.reason
        });
      }
      continue;
    }
    const hallCandidate = reviewBarangayHallCandidate(element);
    hallCandidateReviews.push(hallCandidate.review);
    if (hallCandidate.record) hallRecords.push(hallCandidate.record);
    else rejectedHallCandidates += 1;
  }

  const automatedRoads = buildAutomatedRoadCatalog(roadWays, definitions);
  const unmatchedDefinitionResults = definitions
    .filter((definition) => !automatedRoads.matchedDefinitionKeys.has(definition.segment_key))
    .map((definition) => evaluateRoadDefinition(definition, roadWays));
  const roads = [
    ...automatedRoads.records,
    ...unmatchedDefinitionResults.map((result) => result.record).filter(Boolean)
  ];
  const definitionReviews = unmatchedDefinitionResults.map((result) => result.review);
  const roadReviews = [...automatedRoads.reviews, ...definitionReviews].sort(
    (first, second) => String(first.segment_key).localeCompare(String(second.segment_key))
  );
  const hallByBarangay = new Map();
  hallRecords
    .sort((first, second) =>
      (first.osm_type === "node" ? -1 : 1) -
      (second.osm_type === "node" ? -1 : 1)
    )
    .forEach((record) => {
      if (!hallByBarangay.has(record.barangay)) {
        hallByBarangay.set(record.barangay, record);
      }
    });
  (options.existingHallRecords || []).forEach((record) => {
    if (
      record?.destination_type === "barangay_hall" &&
      record.is_verified &&
      record.is_active &&
      record.barangay &&
      !hallByBarangay.has(record.barangay)
    ) {
      hallByBarangay.set(record.barangay, record);
    }
  });
  const uniqueHalls = [...hallByBarangay.values()];
  const selectedHallKeys = new Set(
    uniqueHalls.map((record) => `${record.osm_type}/${record.osm_id}`)
  );
  const hallReviews = hallCandidateReviews.map((review) => {
    const key = `${review.osm_type}/${review.osm_id}`;
    if (review.verification_status !== "verified" || selectedHallKeys.has(key)) return review;
    return {
      ...review,
      verification_status: "unverified",
      reason: "Another verified catalog record already represents this barangay; manual duplicate review is required."
    };
  });
  uniqueHalls.forEach((record) => {
    const key = `${record.osm_type}/${record.osm_id}`;
    if (hallReviews.some((review) => `${review.osm_type}/${review.osm_id}` === key)) return;
    hallReviews.push({
      osm_type: record.osm_type,
      osm_id: record.osm_id,
      name: record.name,
      barangay: record.barangay,
      coordinate: { latitude: record.latitude, longitude: record.longitude },
      source_tags: null,
      verification_status: "verified",
      reason: "Preserved from the existing reviewed project destination catalog."
    });
  });
  const records = [...roads, ...uniqueHalls];
  records.sort((a, b) =>
    a.destination_type.localeCompare(b.destination_type) ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    a.osm_id.localeCompare(b.osm_id)
  );
  const foundHalls = new Set(
    records.filter((record) => record.destination_type === "barangay_hall").map((record) => record.barangay)
  );
  const exclusionReasons = roadExclusions.reduce((counts, exclusion) => {
    counts[exclusion.reason] = (counts[exclusion.reason] || 0) + 1;
    return counts;
  }, {});
  const roadReviewsByName = new Map();
  automatedRoads.reviews.forEach((review) => {
    const key = review.normalized_road_key || normalizeRoadKey(review.official_road_name);
    if (!roadReviewsByName.has(key)) roadReviewsByName.set(key, []);
    roadReviewsByName.get(key).push(review);
  });
  const duplicateRoadNameGroups = [...roadReviewsByName.entries()]
    .filter(([, componentReviews]) => componentReviews.length > 1)
    .map(([normalizedRoadKey, componentReviews]) => ({
      normalized_road_key: normalizedRoadKey,
      official_display_names: [...new Set(componentReviews.map((review) => review.official_road_name))],
      component_count: componentReviews.length,
      components: componentReviews.map((review) => ({
        segment_key: review.segment_key,
        display_label: review.requested_road_section,
        verification_status: review.verification_status,
        source_osm_way_ids: review.source_osm_way_ids
      }))
    }));
  const missingBarangayHalls = OFFICIAL_BARANGAYS.filter((barangay) => !foundHalls.has(barangay));
  const reviewSummary = {
    total_named_drivable_road_components: automatedRoads.reviews.length,
    total_verified_road_records: roads.length,
    total_geometry_points: roads.reduce((total, road) => total + road.points.length, 0),
    source_osm_way_ids: [...new Set(
      roadReviews.flatMap((review) => review.source_osm_way_ids || review.matched_osm_ids || [])
    )].sort((first, second) => String(first).localeCompare(String(second), "en", { numeric: true })),
    duplicate_road_name_groups: duplicateRoadNameGroups,
    disconnected_components: duplicateRoadNameGroups,
    roads_excluded: roadExclusions.length,
    road_exclusions_by_reason: exclusionReasons,
    verified_barangay_halls: uniqueHalls.map((record) => ({
      barangay: record.barangay,
      name: record.name,
      osm_type: record.osm_type,
      osm_id: record.osm_id
    })),
    unverified_barangay_hall_candidates: hallReviews
      .filter((review) => review.verification_status !== "verified")
      .map((review) => ({
        name: review.name,
        barangay: review.barangay,
        osm_type: review.osm_type,
        osm_id: review.osm_id,
        reason: review.reason
      })),
    missing_barangay_halls: missingBarangayHalls
  };
  return {
    records,
    summary: {
      raw_elements: elements.length,
      unique_osm_objects: uniqueElements.size,
      duplicate_osm_objects_removed: duplicateObjects,
      requested_road_sections: definitions.length,
      eligible_named_drivable_ways: roadWays.length,
      verified_road_sections: roads.length,
      unverified_road_sections: roadReviews.filter((review) => review.verification_status !== "verified").length,
      excluded_named_highway_ways: roadExclusions.length,
      excluded_road_reasons: exclusionReasons,
      barangay_halls: uniqueHalls.length,
      roads_without_geometry: roadsWithoutGeometry,
      rejected_hall_candidates: rejectedHallCandidates,
      total_geometry_points: records.reduce((total, record) => total + record.points.length, 0),
      missing_barangay_halls: missingBarangayHalls
    },
    roadReviews,
    roadExclusions,
    hallReviews,
    reviewSummary
  };
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function sqlNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Cannot generate SQL for an invalid coordinate.");
  return number.toFixed(7);
}

function buildSeedSql(records, generatedAt) {
  const lines = [
    "-- General Santos dispatch destination catalog seed",
    `-- Generated from OpenStreetMap Overpass data at ${generatedAt}`,
    "-- Review before manual execution. This script does not create or alter tables.",
    "-- Idempotency key: (osm_type, osm_id); destination points: (destination_id, point_order).",
    "-- Obsolete point orders are removed only from the matching catalog destination.",
    "START TRANSACTION;",
    ""
  ];
  for (const record of records) {
    const destinationValues = [
      sqlString(record.destination_type), sqlString(record.name), sqlString(record.barangay),
      sqlString(record.display_label), sqlNumber(record.latitude), sqlNumber(record.longitude),
      sqlString(JSON.stringify(record.aliases)), sqlString(JSON.stringify(record.search_keywords)),
      sqlString(record.osm_type), sqlString(record.osm_id), record.is_verified, record.is_active
    ];
    lines.push(
      "INSERT INTO gensan_dispatch_destinations (",
      "  destination_type, name, barangay, display_label, latitude, longitude,",
      "  aliases, search_keywords, osm_type, osm_id, is_verified, is_active, created_at, updated_at",
      ")",
      `SELECT ${destinationValues.join(", ")}, NOW(), NOW()`,
      "FROM DUAL",
      "WHERE NOT EXISTS (",
      "  SELECT 1 FROM gensan_dispatch_destinations",
      `  WHERE osm_type = ${sqlString(record.osm_type)} AND osm_id = ${sqlString(record.osm_id)}`,
      ");",
      "UPDATE gensan_dispatch_destinations",
      `SET destination_type = ${sqlString(record.destination_type)}, name = ${sqlString(record.name)},`,
      `    barangay = ${sqlString(record.barangay)}, display_label = ${sqlString(record.display_label)},`,
      `    latitude = ${sqlNumber(record.latitude)}, longitude = ${sqlNumber(record.longitude)},`,
      `    aliases = ${sqlString(JSON.stringify(record.aliases))}, search_keywords = ${sqlString(JSON.stringify(record.search_keywords))},`,
      `    is_verified = ${record.is_verified}, is_active = ${record.is_active}, updated_at = NOW()`,
      `WHERE osm_type = ${sqlString(record.osm_type)} AND osm_id = ${sqlString(record.osm_id)};`,
      `SET @destination_id = (SELECT id FROM gensan_dispatch_destinations WHERE osm_type = ${sqlString(record.osm_type)} AND osm_id = ${sqlString(record.osm_id)} ORDER BY id ASC LIMIT 1);`
    );
    for (const point of record.points) {
      lines.push(
        "INSERT INTO gensan_dispatch_destination_points (",
        "  destination_id, point_order, point_type, latitude, longitude, created_at",
        ")",
        `SELECT @destination_id, ${point.point_order}, ${sqlString(point.point_type)}, ${sqlNumber(point.latitude)}, ${sqlNumber(point.longitude)}, NOW()`,
        "FROM DUAL",
        "WHERE @destination_id IS NOT NULL",
        "  AND NOT EXISTS (",
        "    SELECT 1 FROM gensan_dispatch_destination_points",
        `    WHERE destination_id = @destination_id AND point_order = ${point.point_order}`,
        "  );",
        "UPDATE gensan_dispatch_destination_points",
        `SET point_type = ${sqlString(point.point_type)}, latitude = ${sqlNumber(point.latitude)}, longitude = ${sqlNumber(point.longitude)}`,
        `WHERE destination_id = @destination_id AND point_order = ${point.point_order};`
      );
    }
    if (record.points.length) {
      lines.push(
        "DELETE FROM gensan_dispatch_destination_points",
        `WHERE destination_id = @destination_id AND point_order > ${record.points.length};`
      );
    }
    lines.push("");
  }
  lines.push("COMMIT;", "");
  return lines.join("\n");
}

function requestOverpass(overpassUrl, query) {
  return new Promise((resolve, reject) => {
    const body = `data=${encodeURIComponent(query)}`;
    const request = https.request(overpassUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "WMO-Gensan-Dispatch-Catalog-Importer/1.0"
      },
      timeout: 210000
    }, (response) => {
      let payload = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { payload += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Overpass returned HTTP ${response.statusCode}: ${payload.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(payload));
        } catch (error) {
          reject(new Error(`Overpass returned invalid JSON: ${error.message}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Overpass request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function printSummary(summary) {
  console.log("General Santos dispatch destination review summary");
  console.log(JSON.stringify(summary, null, 2));
}

async function run() {
  const shouldWrite = process.argv.slice(2).includes("--write");
  const definitionFile = JSON.parse(fs.readFileSync(ROAD_DEFINITIONS_PATH, "utf8"));
  const definitions = Array.isArray(definitionFile.definitions) ? definitionFile.definitions : [];
  if (!definitions.length) {
    throw new Error(`No road section definitions were found in ${ROAD_DEFINITIONS_PATH}.`);
  }
  let existingHallRecords = [];
  if (fs.existsSync(JSON_OUTPUT)) {
    try {
      const existingCatalog = JSON.parse(fs.readFileSync(JSON_OUTPUT, "utf8"));
      existingHallRecords = (existingCatalog.destinations || []).filter(
        (record) => record.destination_type === "barangay_hall"
      );
    } catch (error) {
      console.warn(`Existing catalog could not be read for hall preservation: ${error.message}`);
    }
  }
  let response = null;
  let sourceUrl = "";
  let lastError = null;
  for (const overpassUrl of OVERPASS_URLS) {
    console.log(`Querying ${overpassUrl} for General Santos City roads and barangay halls...`);
    try {
      response = await requestOverpass(overpassUrl, OVERPASS_QUERY);
      sourceUrl = overpassUrl;
      break;
    } catch (error) {
      lastError = error;
      console.warn(`Overpass endpoint unavailable: ${error.message}`);
    }
  }
  if (!response) throw lastError || new Error("No Overpass endpoint was available.");
  const { records, summary, roadReviews, roadExclusions, hallReviews, reviewSummary } = buildCatalog(
    Array.isArray(response.elements) ? response.elements : [],
    definitions,
    { existingHallRecords }
  );
  printSummary(summary);
  if (!records.length) throw new Error("Overpass returned no usable General Santos destinations; no output was written.");
  if (!shouldWrite) {
    console.log("Review only. Re-run with --write to generate JSON and SQL output.");
    return;
  }
  const generatedAt = new Date().toISOString();
  const output = {
    metadata: {
      city: "General Santos City",
      country: "Philippines",
      source: "OpenStreetMap Overpass API",
      source_url: sourceUrl,
      source_license: "ODbL 1.0",
      generated_at: generatedAt,
      review_required_before_database_import: true,
      summary
    },
    destinations: records
  };
  const reviewOutput = {
    metadata: {
      city: "General Santos City",
      country: "Philippines",
      source: "OpenStreetMap Overpass API",
      source_url: sourceUrl,
      generated_at: generatedAt,
      definition_file: path.relative(path.join(__dirname, ".."), ROAD_DEFINITIONS_PATH).replace(/\\/g, "/"),
      note: "Only named, drivable road components with verification_status=verified are included in the generated catalog and seed SQL.",
      boundary_rule: "OpenStreetMap administrative area named General Santos or General Santos City.",
      summary: reviewSummary
    },
    road_sections: roadReviews,
    excluded_ways: roadExclusions,
    barangay_hall_candidates: hallReviews,
    missing_barangay_halls: reviewSummary.missing_barangay_halls.map((barangay) => ({
      barangay,
      verification_status: "missing",
      coordinate: null,
      reason: "No verified barangay-hall source record was available; manual location verification is required."
    }))
  };
  fs.mkdirSync(path.dirname(JSON_OUTPUT), { recursive: true });
  fs.mkdirSync(path.dirname(SQL_OUTPUT), { recursive: true });
  fs.writeFileSync(JSON_OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  fs.writeFileSync(REVIEW_OUTPUT, `${JSON.stringify(reviewOutput, null, 2)}\n`, "utf8");
  fs.writeFileSync(SQL_OUTPUT, buildSeedSql(records, generatedAt), "utf8");
  console.log(`Wrote ${records.length} destinations to ${JSON_OUTPUT}`);
  console.log(`Wrote road section verification evidence to ${REVIEW_OUTPUT}`);
  console.log(`Wrote review-only seed SQL to ${SQL_OUTPUT}`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Destination import failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  OVERPASS_URLS,
  OVERPASS_QUERY,
  OFFICIAL_BARANGAYS,
  DRIVABLE_HIGHWAY_CLASSES,
  normalizeSearchText,
  normalizeRoadKey,
  classifyRoadWay,
  reviewBarangayHallCandidate,
  geometryAnchor,
  connectedWayGroups,
  orderConnectedWayGeometry,
  evaluateRoadDefinition,
  buildAutomatedRoadCatalog,
  buildCatalog,
  buildSeedSql,
  ROAD_DEFINITIONS_PATH,
  REVIEW_OUTPUT
};
