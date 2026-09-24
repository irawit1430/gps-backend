// A route's timetable laid along its road, in the order one leg actually drives it.
//
// The route editor stores stops in pickup order, each with `expectedArrivalMinutes`
// counted from the first stop, and the road it asked a router for as `geometry`. Every
// ETA used to read that number as-is, which went wrong three ways:
//
//   - On the way home the bus drives the stops backwards, school first. The first house
//     kept its morning 0 minutes, so the afternoon timetable was upside down.
//   - The minutes are pure driving time. The bus also waits at every stop, so each ETA
//     ran early by about the number of stops before it.
//   - It said nothing about where the bus is. This file places each stop at a distance
//     along the road, which is what lets liveEta.js turn a GPS fix into "this far along
//     the route, so this many minutes to your stop".
//
// Pure: no database, no clock. liveEta.js does the loading and caching.

const EARTH_M = 6371000;
const RAD = Math.PI / 180;

// Google's encoded polyline format, which both OSRM and the Routes API return.
function decodePolyline(str) {
  const points = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        if (Number.isNaN(byte) || byte < 0) return points;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

// Flat metres around one reference latitude: exact enough across a school route.
const flat = (p, refLat) => ({ x: p.lng * RAD * EARTH_M * Math.cos(refLat * RAD), y: p.lat * RAD * EARTH_M });

// Every place along the line within `maxDist` metres of the point, one per segment.
function project(plan, lat, lng, maxDist = Infinity, fromSeg = 0) {
  const p = flat({ lat, lng }, plan.refLat);
  const out = [];
  for (let i = Math.max(0, fromSeg); i < plan.line.length - 1; i++) {
    const a = plan.line[i], b = plan.line[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const dist = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (dist <= maxDist) out.push({ seg: i, along: a.cum + t * (b.cum - a.cum), dist });
  }
  return out;
}

// route: { geometry, stops: [{ id, lat, lng, orderIdx, expectedArrivalMinutes }] }
// direction: the trip's RunDirection, or null for a hand-made trip (pickup order).
function buildPlan(route, direction, dwellMinutes = 0) {
  const pickupOrder = [...(route?.stops || [])].sort((a, b) => a.orderIdx - b.orderIdx);
  if (pickupOrder.length === 0) return null;
  const reverse = direction === 'FROM_SCHOOL';
  const inOrder = reverse ? [...pickupOrder].reverse() : pickupOrder;

  // Driving minutes from this leg's first stop. Homeward, a stop that was 25 minutes
  // into a 30-minute morning is 5 minutes from the school end. That assumes the road
  // takes as long each way, which beats reading the morning numbers backwards.
  const timed = pickupOrder.map((s) => s.expectedArrivalMinutes).filter((m) => m != null);
  const span = timed.length ? Math.max(...timed) : null;
  const drive = (m) => (m == null ? null : reverse ? span - m : m);

  // The road, in driving order. Without a stored geometry the stops themselves are the
  // line: straight hops, still enough to tell which stops are behind the bus.
  let pts = typeof route.geometry === 'string' && route.geometry ? decodePolyline(route.geometry) : [];
  if (pts.length < 2) pts = pickupOrder.map((s) => ({ lat: s.lat, lng: s.lng }));
  if (reverse) pts = [...pts].reverse();
  const refLat = pts[0].lat;
  const line = [];
  let cum = 0;
  for (const pt of pts) {
    const xy = flat(pt, refLat);
    if (line.length) cum += Math.hypot(xy.x - line[line.length - 1].x, xy.y - line[line.length - 1].y);
    line.push({ ...xy, cum });
  }
  const plan = { refLat, line, length: cum, dwellMinutes, stops: [] };

  // Each stop's place on the road, never behind the one before it. A road that passes
  // a later stop early (a loop, a street driven both ways) must not pull it forward, so
  // of the stretches still ahead, take the first that is about as close as the closest.
  let seg = 0, along = 0;
  inOrder.forEach((s, rank) => {
    const near = line.length > 1 ? project(plan, s.lat, s.lng, Infinity, seg).filter((c) => c.along >= along - 1) : [];
    if (near.length) {
      const best = Math.min(...near.map((c) => c.dist));
      const pick = near.find((c) => c.dist <= best + 50);
      seg = pick.seg;
      along = Math.max(along, pick.along);
    }
    const minutes = drive(s.expectedArrivalMinutes);
    plan.stops.push({
      id: s.id,
      rank,
      along,
      // Arrival, counted from departure: driving time plus a wait at every stop the
      // bus has already made. The first stop is where the trip starts, so no wait.
      planned: minutes == null ? null : minutes + dwellMinutes * Math.max(0, rank - 1),
    });
  });
  return plan;
}

// Planned arrival at a stop, in minutes from the start of the leg. null when the route
// has no time for it.
function plannedMinutes(plan, stopId) {
  return plan?.stops.find((s) => s.id === stopId)?.planned ?? null;
}

// Where the timetable says the bus should be, in minutes from the start, when it is
// `along` metres down the road. Between two stops it is interpolated from leaving the
// first (after its wait) to reaching the second.
function plannedAt(plan, along) {
  const timed = plan.stops.filter((s) => s.planned != null);
  if (timed.length === 0) return null;
  if (along <= timed[0].along) return timed[0].planned;
  for (let i = 0; i < timed.length - 1; i++) {
    const a = timed[i], b = timed[i + 1];
    if (along > b.along) continue;
    const leave = a.planned + (a.rank >= 1 ? plan.dwellMinutes : 0);
    if (b.along === a.along) return b.planned;
    return leave + (b.planned - leave) * ((along - a.along) / (b.along - a.along));
  }
  return timed[timed.length - 1].planned;
}

module.exports = { buildPlan, plannedMinutes, plannedAt, project, decodePolyline };
