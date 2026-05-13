function normalizePolygon(polygon) {
  if (!polygon) return [];


  if (
    typeof polygon === "object" &&
    !Array.isArray(polygon) &&
    polygon.type === "Polygon" &&
    Array.isArray(polygon.coordinates) &&
    Array.isArray(polygon.coordinates[0])
  ) {
    return polygon.coordinates[0]
      .map((coord) => {
        if (!Array.isArray(coord) || coord.length < 2) return null;

        return {
          lng: Number(coord[0]),
          lat: Number(coord[1])
        };
      })
      .filter(
        (point) =>
          point &&
          !Number.isNaN(point.lat) &&
          !Number.isNaN(point.lng)
      );
  }

  // ✅ Support raw array format: [ [lng, lat], [lng, lat] ]
  if (Array.isArray(polygon)) {
    return polygon
      .map((point) => {
        // Format: { lat, lng }
        if (
          point &&
          typeof point === "object" &&
          !Array.isArray(point) &&
          point.lat !== undefined &&
          point.lng !== undefined
        ) {
          return {
            lat: Number(point.lat),
            lng: Number(point.lng)
          };
        }

        // Format: [lng, lat]
        if (Array.isArray(point) && point.length >= 2) {
          return {
            lng: Number(point[0]),
            lat: Number(point[1])
          };
        }

        return null;
      })
      .filter(
        (point) =>
          point &&
          !Number.isNaN(point.lat) &&
          !Number.isNaN(point.lng)
      );
  }

  return [];
}

function isPointInPolygon(point, polygon) {
  const x = Number(point.lng);
  const y = Number(point.lat);

  if (
    Number.isNaN(x) ||
    Number.isNaN(y) ||
    !Array.isArray(polygon) ||
    polygon.length < 3
  ) {
    return false;
  }

  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i].lng);
    const yi = Number(polygon[i].lat);
    const xj = Number(polygon[j].lng);
    const yj = Number(polygon[j].lat);

    if (
      Number.isNaN(xi) ||
      Number.isNaN(yi) ||
      Number.isNaN(xj) ||
      Number.isNaN(yj)
    ) {
      continue;
    }

    const intersect =
      ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
}

function getPolygonCentroid(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;

  let totalLat = 0;
  let totalLng = 0;
  let count = 0;

  for (const point of polygon) {
    const lat = Number(point.lat);
    const lng = Number(point.lng);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      continue;
    }

    totalLat += lat;
    totalLng += lng;
    count++;
  }

  if (count === 0) return null;

  return {
    lat: totalLat / count,
    lng: totalLng / count
  };
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function calculateDistanceMeters(pointA, pointB) {
  const lat1 = Number(pointA.lat);
  const lng1 = Number(pointA.lng);
  const lat2 = Number(pointB.lat);
  const lng2 = Number(pointB.lng);

  if (
    Number.isNaN(lat1) ||
    Number.isNaN(lng1) ||
    Number.isNaN(lat2) ||
    Number.isNaN(lng2)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function resolveBarangayByPolygon(point, boundaries) {
  if (!Array.isArray(boundaries)) return null;

  for (const boundary of boundaries) {
    let polygon = boundary.polygon_json;

    if (typeof polygon === "string") {
      try {
        polygon = JSON.parse(polygon);
      } catch (error) {
        console.error("Invalid polygon JSON for barangay:", boundary.barangay_name);
        continue;
      }
    }

    const normalizedPolygon = normalizePolygon(polygon);

    if (normalizedPolygon.length < 3) {
      continue;
    }

    if (isPointInPolygon(point, normalizedPolygon)) {
      return boundary.barangay_name;
    }
  }

  return null;
}


function toProjectedPoint(point, referenceLat) {
  const lat = Number(point.lat);
  const lng = Number(point.lng);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  const earthRadius = 6371000;
  const latRad = toRadians(lat);
  const lngRad = toRadians(lng);
  const referenceLatRad = toRadians(Number(referenceLat) || 0);

  return {
    x: earthRadius * lngRad * Math.cos(referenceLatRad),
    y: earthRadius * latRad
  };
}

function calculatePointToSegmentDistanceMeters(point, segmentStart, segmentEnd) {
  const referenceLat = Number(point.lat);

  const p = toProjectedPoint(point, referenceLat);
  const a = toProjectedPoint(segmentStart, referenceLat);
  const b = toProjectedPoint(segmentEnd, referenceLat);

  if (!p || !a || !b) {
    return Number.POSITIVE_INFINITY;
  }

  const abX = b.x - a.x;
  const abY = b.y - a.y;
  const apX = p.x - a.x;
  const apY = p.y - a.y;

  const abLengthSquared = abX * abX + abY * abY;

  if (abLengthSquared === 0) {
    return Math.sqrt(apX * apX + apY * apY);
  }

  const t = Math.max(
    0,
    Math.min(1, (apX * abX + apY * abY) / abLengthSquared)
  );

  const closestX = a.x + t * abX;
  const closestY = a.y + t * abY;

  const dx = p.x - closestX;
  const dy = p.y - closestY;

  return Math.sqrt(dx * dx + dy * dy);
}

function getDistanceToPolygonMeters(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return Number.POSITIVE_INFINITY;
  }

  /*
    If the point is inside the polygon, distance is zero.
    This protects exact boundary assignments.
  */
  if (isPointInPolygon(point, polygon)) {
    return 0;
  }

  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];

    const distance = calculatePointToSegmentDistanceMeters(point, current, next);

    if (distance < nearestDistance) {
      nearestDistance = distance;
    }
  }

  return nearestDistance;
}


function resolveNearestBarangay(point, boundaries) {
  if (!Array.isArray(boundaries) || boundaries.length === 0) {
    return null;
  }

  let nearestBarangay = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const boundary of boundaries) {
    let polygon = boundary.polygon_json;

    if (typeof polygon === "string") {
      try {
        polygon = JSON.parse(polygon);
      } catch (error) {
        console.error("Invalid polygon JSON for nearest lookup:", boundary.barangay_name);
        continue;
      }
    }

    const normalizedPolygon = normalizePolygon(polygon);

    if (normalizedPolygon.length < 3) {
      continue;
    }

    /*
      More accurate than centroid-only:
      - Measures the point's distance to the barangay polygon edges.
      - This prevents assigning to a barangay only because its centroid is near,
        while another polygon boundary is actually closer.
    */
    let distance = getDistanceToPolygonMeters(point, normalizedPolygon);

    /*
      Fallback safety:
      If distance-to-polygon fails, use centroid distance.
    */
    if (!Number.isFinite(distance)) {
      const centroid = getPolygonCentroid(normalizedPolygon);
      if (!centroid) {
        continue;
      }

      distance = calculateDistanceMeters(point, centroid);
    }

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestBarangay = boundary.barangay_name;
    }
  }

  return nearestBarangay;
}

module.exports = {
  normalizePolygon,
  isPointInPolygon,
  resolveBarangayByPolygon,
  getPolygonCentroid,
  calculateDistanceMeters,
  getDistanceToPolygonMeters,
  resolveNearestBarangay
};
