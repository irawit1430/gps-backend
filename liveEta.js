// How far along its route each running bus is, from its GPS, and the ETA that follows.
//
// Until this existed the ETA a parent saw was the trip's start time plus the stop's
// timetable minutes, full stop. A bus stuck in traffic kept promising the old time and
// then simply read "late"; the bus's own position was only ever used when the route had
// no times at all. Now each live fix is placed on the route's road (routePlan.js), and
// the ETA is: when that fix was taken, plus the timetable's minutes still to go from
// there. A bus that stands still sees its ETAs move later; one that makes up time sees
// them come forward.
//
// In memory, like the other per-bus live state (busPresence, liveFixGuard): the server
// runs as one process. After a restart the next fix rebuilds it, and until then ETAs
// fall back to the timetable.

const { buildPlan, plannedAt, project } = require('./routePlan');
const config = require('./config');

// A fix further than this from the route line is a detour or a bad fix: it does not
// move the bus along the route.
const ON_ROUTE_M = 300;
// Within this of a stop's place on the road, the bus has reached it.
const ARRIVED_M = 50;
// A live position older than this says where the bus was, not where it is. The ETA
// falls back to the timetable rather than freeze.
const LIVE_MAX_AGE_MS = 5 * 60_000;
// After this long without a usable fix, the bus may be anywhere down the road.
const REACQUIRE_AFTER_MS = 10 * 60_000;
const PLAN_TTL_MS = 2 * 60_000;
const TRIP_TTL_MS = 60_000;
const MAX_TRIPS = 2000;

const RUNNING = new Set(['ON_SCHEDULE', 'DELAYED']);

const plans = new Map(); // `${routeId}:${direction}` → { plan, expires }
const trips = new Map(); // tripId → { trip, expires }
const progress = new Map(); // tripId → { along, at, passed: Map<stopId, ms> }
let approachHandler = null;

const planKey = (routeId, direction) => `${routeId}:${direction || ''}`;

function bounded(map, key, value) {
  if (!map.has(key) && map.size >= MAX_TRIPS) map.delete(map.keys().next().value);
  map.set(key, value);
}

async function loadPlan(prisma, routeId, direction) {
  const key = planKey(routeId, direction);
  const hit = plans.get(key);
  if (hit && hit.expires > Date.now()) return hit.plan;
  const route = await prisma.route.findUnique({
    where: { id: routeId },
    select: {
      geometry: true,
      estimatedDuration: true,
      school: { select: { latitude: true, longitude: true, stopDwellMinutes: true } },
      stops: { orderBy: { orderIdx: 'asc' }, select: { id: true, lat: true, lng: true, orderIdx: true, expectedArrivalMinutes: true } },
    },
  });
  // The school's own waiting time, or the server default.
  const dwell = route?.school?.stopDwellMinutes ?? config.STOP_DWELL_MINUTES;
  const school = route?.school?.latitude != null && route?.school?.longitude != null
    ? { lat: route.school.latitude, lng: route.school.longitude }
    : null;
  const plan = route ? buildPlan(route, direction, dwell, school) : null;
  bounded(plans, key, { plan, expires: Date.now() + PLAN_TTL_MS });
  return plan;
}

// The plans for a set of trips, keyed for etaFor. A route that fails to load just has
// no plan; its ETAs stay on the old timetable reading.
async function plansFor(prisma, tripList) {
  const out = new Map();
  for (const t of tripList || []) {
    if (!t?.routeId) continue;
    const key = planKey(t.routeId, t.direction);
    if (out.has(key)) continue;
    try {
      out.set(key, await loadPlan(prisma, t.routeId, t.direction));
    } catch {
      out.set(key, null);
    }
  }
  return out;
}

async function loadTrip(prisma, tripId) {
  const hit = trips.get(tripId);
  if (hit && hit.expires > Date.now()) return hit.trip;
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    select: { id: true, routeId: true, direction: true, status: true, startTime: true, scheduledStart: true },
  });
  bounded(trips, tripId, { trip, expires: Date.now() + TRIP_TTL_MS });
  return trip;
}

// Choose where on the road a fix is. Candidates are every stretch within ON_ROUTE_M;
// a road that runs past itself gives more than one, and the right one is the one that
// follows on from where the bus last was, or, with no history, the one the timetable
// expects by now.
function place(plan, state, trip, fix) {
  let cands = project(plan, fix.lat, fix.lng, ON_ROUTE_M);
  if (cands.length === 0) return null;
  if (state) {
    const gap = fix.at - state.at;
    const reach = gap < REACQUIRE_AFTER_MS ? Math.max(800, (gap / 1000) * 25 + 300) : Infinity;
    cands = cands.filter((c) => c.along >= state.along - 150 && c.along <= state.along + reach);
    if (cands.length === 0) return null;
  }
  const best = Math.min(...cands.map((c) => c.dist));
  const close = cands.filter((c) => c.dist <= best + 30);
  let score;
  if (state) {
    score = (c) => Math.abs(c.along - state.along);
  } else {
    const start = trip.startTime || trip.scheduledStart;
    const elapsed = start ? (fix.at - new Date(start).getTime()) / 60_000 : null;
    score = elapsed == null ? (c) => c.along : (c) => Math.abs((plannedAt(plan, c.along) ?? 0) - elapsed);
  }
  return close.reduce((a, b) => (score(b) < score(a) ? b : a));
}

// Called by both GPS paths for every live, in-order fix on a running trip. Never
// throws and is not awaited by the caller: a fix must land whatever happens here.
async function onFix(prisma, { tripId, lat, lng, at }, logger) {
  if (!tripId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  try {
    const trip = await loadTrip(prisma, tripId);
    if (!trip || !RUNNING.has(trip.status)) return;
    const plan = await loadPlan(prisma, trip.routeId, trip.direction);
    if (!plan) return;
    // A phone clock running ahead must not put the bus in the future.
    const fix = { lat, lng, at: Math.min(at instanceof Date ? at.getTime() : Date.now(), Date.now()) };
    const state = progress.get(tripId);
    if (state && fix.at <= state.at) return;
    const spot = place(plan, state, trip, fix);
    if (!spot) return; // off the route: the bus keeps its last place, and its ETAs slip
    const next = {
      along: Math.max(state?.along ?? 0, spot.along),
      at: fix.at,
      passed: state?.passed || new Map(),
    };
    for (const s of plan.stops) {
      if (!next.passed.has(s.id) && s.along - ARRIVED_M <= next.along) next.passed.set(s.id, fix.at);
    }
    bounded(progress, tripId, next);
    if (approachHandler) await approachHandler({ trip, plan, progress: next, now: fix.at });
  } catch (err) {
    logger?.warn?.({ err: err.message, tripId }, 'live ETA: could not place fix');
  }
}

// ETA fields for one stop on one trip. Live when the bus has reported recently from
// the route; otherwise the timetable, now counted in the leg's own direction and with
// the stops' waiting time.
function etaFor(trip, stop, planMap, now = new Date()) {
  const base = { arrivalConfirmed: false };
  const none = { ...base, etaKind: 'SCHEDULE_PROJECTION', etaConfidence: 'SCHEDULE_ONLY', stopEtaAt: null, stopEtaMinutes: null, etaBasis: null, etaStatus: 'UNAVAILABLE', overdue: false };
  if (!trip || !stop || ['COMPLETED', 'CANCELLED'].includes(trip.status)) return none;
  const plan = planMap?.get(planKey(trip.routeId, trip.direction)) || null;
  const planned = plan ? plan.stops.find((s) => s.id === stop.id)?.planned ?? null : stop.expectedArrivalMinutes ?? null;
  if (planned == null) return none;
  const nowMs = +now;
  const shape = (atMs, basis, kind, confidence, status) => ({
    ...base, etaKind: kind, etaConfidence: confidence,
    stopEtaAt: new Date(atMs).toISOString(), stopEtaMinutes: Math.round((atMs - nowMs) / 60_000),
    etaBasis: basis, etaStatus: status ?? (atMs <= nowMs ? 'OVERDUE_UNCONFIRMED' : 'ESTIMATED'), overdue: status ? false : atMs <= nowMs,
  });

  const live = plan && RUNNING.has(trip.status) ? progress.get(trip.id) : null;
  if (live && nowMs - live.at <= LIVE_MAX_AGE_MS) {
    const passedAt = live.passed.get(stop.id);
    if (passedAt) return shape(passedAt, 'LIVE_POSITION', 'LIVE_GPS', 'LIVE', 'ARRIVED');
    const here = plannedAt(plan, live.along);
    if (here != null) return shape(live.at + Math.max(0, planned - here) * 60_000, 'LIVE_POSITION', 'LIVE_GPS', 'LIVE');
  }

  const anchor = trip.startTime || trip.scheduledStart;
  if (!anchor) return none;
  return shape(+new Date(anchor) + planned * 60_000, trip.startTime ? 'ACTUAL_START' : 'SCHEDULED_START', 'SCHEDULE_PROJECTION', 'SCHEDULE_ONLY');
}

// When the bus reached a stop, from its GPS, or null.
function passedAt(tripId, stopId) {
  const at = progress.get(tripId)?.passed.get(stopId);
  return at ? new Date(at) : null;
}

// A trip's status, start time or route changed: read it again on the next fix.
function tripChanged(tripId) {
  trips.delete(tripId);
}

// A school's timing settings or location changed: rebuild every plan on next use.
function plansChanged() {
  plans.clear();
}

function onApproach(handler) {
  approachHandler = handler;
}

function clear() {
  plans.clear();
  trips.clear();
  progress.clear();
}

module.exports = { onFix, etaFor, plansFor, passedAt, tripChanged, plansChanged, onApproach, clear, planKey, LIVE_MAX_AGE_MS };
