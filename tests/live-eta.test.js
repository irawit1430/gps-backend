// The ETA follows the bus. It used to be the start time plus the stop's timetable
// minutes whatever the bus did, so a bus stuck in traffic kept promising the old time.

const liveEta = require('../liveEta');

// Four stops about 1.1 km apart on one east-west road: A 0, B 4, C 8, D 12 minutes.
const at = (lngOffset) => ({ lat: 12.97, lng: 77.6 + lngOffset });
const route = {
  geometry: null,
  stops: [['A', 0, 0], ['B', 0.01, 4], ['C', 0.02, 8], ['D', 0.03, 12]]
    .map(([id, off, minutes], orderIdx) => ({ id, ...at(off), expectedArrivalMinutes: minutes, orderIdx })),
};
const T0 = Date.parse('2026-09-24T02:00:00Z'); // 07:30 IST
const min = (n) => T0 + n * 60_000;

let trip;
const prisma = {
  trip: { findUnique: jest.fn(async () => trip) },
  route: { findUnique: jest.fn(async () => route) },
};
let n = 0;

beforeEach(() => {
  liveEta.clear();
  liveEta.onApproach(null);
  trip = { id: `trip-${++n}`, routeId: 'r1', direction: 'TO_SCHOOL', status: 'ON_SCHEDULE', startTime: new Date(T0), scheduledStart: new Date(T0) };
});

const fix = (lngOffset, minute) => liveEta.onFix(prisma, { tripId: trip.id, ...at(lngOffset), at: new Date(min(minute)) });
const eta = async (stopId, nowMinute) => {
  const plans = await liveEta.plansFor(prisma, [trip]);
  return liveEta.etaFor(trip, { id: stopId }, plans, new Date(min(nowMinute)));
};
const clock = (e) => (Date.parse(e.stopEtaAt) - T0) / 60_000;

// Fixes are "now" in these tests, so the clock cannot run ahead of them.
beforeAll(() => jest.useFakeTimers({ now: min(60), doNotFake: ['nextTick', 'setImmediate'] }));
afterAll(() => jest.useRealTimers());

it('counts from where the bus is: halfway to B at 2 min, C is 7 min on', async () => {
  await fix(0.005, 2);

  const e = await eta('C', 2);
  // C is 8 min of driving plus a minute waiting at B: 9. The bus is 2 minutes in.
  expect(clock(e)).toBeCloseTo(9, 1);
  expect(e).toMatchObject({ etaBasis: 'LIVE_POSITION', etaKind: 'LIVE_GPS', etaStatus: 'ESTIMATED' });
});

it('moves later while the bus stands still', async () => {
  await fix(0.005, 2);
  await fix(0.005, 6); // still there four minutes later

  expect(clock(await eta('C', 6))).toBeCloseTo(13, 1);
});

it('says when the bus reached a stop', async () => {
  await fix(0.005, 2);
  await fix(0.0101, 5);

  const e = await eta('B', 6);
  expect(e.etaStatus).toBe('ARRIVED');
  expect(clock(e)).toBe(5);
  expect(liveEta.passedAt(trip.id, 'B')).toEqual(new Date(min(5)));
  expect(liveEta.passedAt(trip.id, 'C')).toBeNull();
});

it('ignores a fix off the route: the bus keeps its place, and its ETA slips', async () => {
  await fix(0.005, 2);
  await liveEta.onFix(prisma, { tripId: trip.id, lat: 12.99, lng: 77.625, at: new Date(min(3)) }); // 2 km off

  expect(clock(await eta('C', 3))).toBeCloseTo(9, 1);
});

it('never moves the bus backwards', async () => {
  await fix(0.015, 4);
  await fix(0.012, 5); // GPS jitter behind

  expect(liveEta.passedAt(trip.id, 'B')).toEqual(new Date(min(4)));
  expect(clock(await eta('C', 5))).toBeLessThan(10);
});

it('falls back to the timetable when the bus has not reported for five minutes', async () => {
  await fix(0.005, 2);

  const e = await eta('C', 8);
  expect(e.etaBasis).toBe('ACTUAL_START');
  expect(clock(e)).toBe(9); // start plus 8 driving plus 1 waiting at B
});

it('uses the timetable before the bus has reported at all', async () => {
  trip = { ...trip, status: 'PLANNED', startTime: null };

  const e = await eta('D', 0);
  expect(e).toMatchObject({ etaBasis: 'SCHEDULED_START', etaKind: 'SCHEDULE_PROJECTION' });
  expect(clock(e)).toBe(14); // 12 driving plus a minute at B and at C
});

it('times the way home from the school end', async () => {
  trip = { ...trip, direction: 'FROM_SCHOOL' };

  // Morning D (12 min) is where the afternoon starts, so A is 12 driving + 2 waits.
  expect(clock(await eta('D', 0))).toBe(0);
  expect(clock(await eta('A', 0))).toBe(14);

  await fix(0.025, 2); // halfway from D to C
  expect(clock(await eta('B', 2))).toBeCloseTo(2 + 2 + 1 + 4, 1);
});

it('offers nothing for a finished trip', async () => {
  trip = { ...trip, status: 'COMPLETED' };

  expect((await eta('C', 5)).etaStatus).toBe('UNAVAILABLE');
});

it('tells the approach handler where the bus is', async () => {
  const seen = [];
  liveEta.onApproach(async ({ plan, progress }) => seen.push({ stops: plan.stops.length, along: Math.round(progress.along) }));

  await fix(0.005, 2);

  expect(seen).toEqual([{ stops: 4, along: expect.any(Number) }]);
  expect(seen[0].along).toBeGreaterThan(500);
});

it('does nothing for a trip that is not running', async () => {
  trip = { ...trip, status: 'PLANNED' };
  await fix(0.005, 2);

  expect(liveEta.passedAt(trip.id, 'A')).toBeNull();
});
