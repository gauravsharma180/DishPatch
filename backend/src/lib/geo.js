const R = 6371000; // earth radius, metres
const toRad = (d) => (d * Math.PI) / 180;

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Straight-line distance underestimates road distance; 1.35 is a common city detour factor.
const ROAD_FACTOR = 1.35;
const SPEED_KMPH = { BIKE: 22, SCOOTER: 25, CYCLE: 12 };

/** Rough travel-time estimate in seconds. A real system would call a routing engine (OSRM etc). */
export function etaSeconds(distanceMeters, vehicle = 'BIKE') {
  const speedMps = ((SPEED_KMPH[vehicle] || SPEED_KMPH.BIKE) * 1000) / 3600;
  return Math.round((distanceMeters * ROAD_FACTOR) / speedMps);
}

/** Snap a coordinate to a ~1.1km grid cell; used as a cache key for "nearby" lookups. */
export function gridCell(lat, lng, precision = 2) {
  return `${lat.toFixed(precision)}:${lng.toFixed(precision)}`;
}

/** Move from (lat,lng) toward (tLat,tLng) by at most stepMeters. Used by the simulator. */
export function stepToward(lat, lng, tLat, tLng, stepMeters) {
  const d = haversineMeters(lat, lng, tLat, tLng);
  if (d <= stepMeters) return { lat: tLat, lng: tLng, arrived: true };
  const f = stepMeters / d;
  return { lat: lat + (tLat - lat) * f, lng: lng + (tLng - lng) * f, arrived: false };
}
