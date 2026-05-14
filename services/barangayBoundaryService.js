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


function calculatePolygonAreaScore(polygon) {
  /*
    Area score is used only for tie-breaking overlapping barangay polygons.
    Smaller polygon wins because it is usually the more specific/accurate boundary.
  */
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return Number.POSITIVE_INFINITY;
  }

  let area = 0;

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

    area += (xj * yi) - (xi * yj);
  }

  return Math.abs(area / 2);
}


function resolveBarangayByPolygon(point, boundaries) {
  if (!Array.isArray(boundaries)) return null;

  const matches = [];

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
      const centroid = getPolygonCentroid(normalizedPolygon);
      const centroidDistance = centroid
        ? calculateDistanceMeters(point, centroid)
        : Number.POSITIVE_INFINITY;

      matches.push({
        barangay_name: boundary.barangay_name,
        area_score: calculatePolygonAreaScore(normalizedPolygon),
        centroid_distance: centroidDistance
      });
    }
  }

  if (!matches.length) {
    return null;
  }

  /*
    IMPORTANT:
    If polygons overlap, do not return the first row from MySQL.
    Example: a broad Lagao polygon can overlap Mabuhay/San Isidro.
    The smaller polygon is usually the correct barangay coverage.
  */
  matches.sort((a, b) => {
    if (a.area_score !== b.area_score) {
      return a.area_score - b.area_score;
    }

    return a.centroid_distance - b.centroid_distance;
  });

  return matches[0].barangay_name || null;
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
  calculatePolygonAreaScore,
  resolveNearestBarangay
};
