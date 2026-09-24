const { calendarDate, DEFAULT_ZONE } = require('./schoolTime');
const moving = t => ['ON_SCHEDULE', 'DELAYED'].includes(t?.status);
const matchesDirection = (mapping, trip) => !mapping.direction || !trip.direction || mapping.direction === trip.direction;
function selectJourney(mappings, now = new Date(), zone = DEFAULT_ZONE) {
  const today = calendarDate(now, zone);
  const candidates = (mappings || []).flatMap(m => (m.routeStop?.route?.trips || [])
    .filter(t => matchesDirection(m, t))
    .filter(t => {
      const instant = t.startTime || t.scheduledStart || t.createdAt;
      const day = t.serviceDate ? new Date(t.serviceDate).toISOString().slice(0, 10) : instant ? calendarDate(instant, zone) : today;
      return day === today;
    }).map(trip => ({ stop: m.routeStop, direction: m.direction, trip })));
  const rank = t => moving(t) ? 0 : t.status === 'PLANNED' ? 1 : t.status === 'COMPLETED' ? 2 : 3;
  candidates.sort((a, b) => rank(a.trip) - rank(b.trip) ||
    (moving(a.trip) || a.trip.status === 'COMPLETED'
      ? +new Date(b.trip.startTime || b.trip.createdAt || 0) - +new Date(a.trip.startTime || a.trip.createdAt || 0)
      : +new Date(a.trip.scheduledStart || a.trip.createdAt || 0) - +new Date(b.trip.scheduledStart || b.trip.createdAt || 0)) ||
    Number(!a.direction) - Number(!b.direction));
  return candidates[0] || { stop: mappings?.[0]?.routeStop || null, trip: null };
}
function selectNextJourney(mappings, now = new Date()) {
  const candidates = (mappings || []).flatMap(m => (m.routeStop?.route?.trips || [])
    .filter(t => matchesDirection(m, t) && t.status === 'PLANNED' && t.scheduledStart && +new Date(t.scheduledStart) > +now)
    .map(trip => ({ stop: m.routeStop, trip })));
  candidates.sort((a, b) => +new Date(a.trip.scheduledStart) - +new Date(b.trip.scheduledStart));
  return candidates[0] || null;
}
function journeyState(trip, scan) {
  if (!trip) return 'UNKNOWN';
  if (trip.status === 'CANCELLED') return 'CANCELLED';
  if (scan?.type === 'ALIGHTED') return 'DROP_OFF_RECORDED';
  if (trip.status === 'COMPLETED') return 'COMPLETED';
  if (scan?.type === 'BOARDED') return 'ON_BOARD';
  if (scan?.type === 'NO_SHOW') return 'NO_SHOW';
  return moving(trip) ? 'ACTIVE' : 'SCHEDULED';
}
// Stop ETAs live in liveEta.js, which knows the bus's position and the leg's direction.
module.exports = { selectJourney, selectNextJourney, journeyState, matchesDirection };
