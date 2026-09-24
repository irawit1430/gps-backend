// The timetable a leg actually drives: the right direction, a wait at each stop, and
// every stop placed along the road so a GPS fix can say how far the bus has come.

const { buildPlan, plannedMinutes, plannedAt, decodePolyline } = require('../routePlan');
const { encode } = require('./helpers/polyline');

// Four stops about 1.1 km apart on one straight east-west road, no stored geometry.
const stop = (id, lngOffset, minutes, orderIdx) => ({ id, lat: 12.97, lng: 77.6 + lngOffset, expectedArrivalMinutes: minutes, orderIdx });
const route = {
  geometry: null,
  stops: [stop('A', 0, 0, 0), stop('B', 0.01, 8, 1), stop('C', 0.02, 15, 2), stop('D', 0.03, 20, 3)],
};

describe('buildPlan', () => {
  it('adds a wait at every stop before yours, not at the one the trip starts from', () => {
    const plan = buildPlan(route, 'TO_SCHOOL', 1);

    expect(plan.stops.map((s) => [s.id, s.planned])).toEqual([['A', 0], ['B', 8], ['C', 16], ['D', 22]]);
  });

  it('drives the stops backwards on the way home, counting from the school end', () => {
    const plan = buildPlan(route, 'FROM_SCHOOL', 1);

    // D is 20 min into the morning, so it is where the afternoon starts; A is last.
    expect(plan.stops.map((s) => [s.id, s.planned])).toEqual([['D', 0], ['C', 5], ['B', 13], ['A', 22]]);
    expect(plannedMinutes(plan, 'A')).toBe(22);
  });

  it('keeps the morning order for a hand-made trip with no direction', () => {
    expect(buildPlan(route, null, 0).stops.map((s) => s.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('leaves a stop with no time untimed instead of inventing one', () => {
    const plan = buildPlan({ ...route, stops: [stop('A', 0, 0, 0), stop('B', 0.01, null, 1), stop('C', 0.02, 15, 2)] }, 'TO_SCHOOL', 1);

    expect(plannedMinutes(plan, 'B')).toBeNull();
    expect(plannedMinutes(plan, 'C')).toBe(16);
  });

  it('places the stops along the road in driving order, about 1.1 km apart', () => {
    const plan = buildPlan(route, 'TO_SCHOOL', 0);
    const along = plan.stops.map((s) => Math.round(s.along / 100) / 10);

    expect(along).toEqual([0, 1.1, 2.2, 3.3]);
  });

  it('does not pull a later stop forward when the road passes it early', () => {
    // Out along a street and back the same way: C sits beside the outbound leg too.
    const out = [{ lat: 12.97, lng: 77.6 }, { lat: 12.97, lng: 77.62 }, { lat: 12.9701, lng: 77.6 }];
    const plan = buildPlan({
      geometry: encode(out),
      stops: [stop('A', 0, 0, 0), stop('B', 0.02, 5, 1), { id: 'C', lat: 12.9701, lng: 77.605, expectedArrivalMinutes: 9, orderIdx: 2 }],
    }, 'TO_SCHOOL', 0);

    const [a, b, c] = plan.stops.map((s) => s.along);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b); // on the way back, not the way out
  });
});

describe('plannedAt', () => {
  const plan = buildPlan(route, 'TO_SCHOOL', 1);

  it('is the arrival time at a stop', () => {
    expect(plannedAt(plan, plan.stops[2].along)).toBeCloseTo(16, 5);
  });

  it('runs from leaving one stop, after its wait, to reaching the next', () => {
    const halfway = (plan.stops[1].along + plan.stops[2].along) / 2;

    expect(plannedAt(plan, halfway)).toBeCloseTo(12.5, 5); // leave B at 9, reach C at 16
  });
});

it('decodes the route shape the routers return', () => {
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');

  expect(pts.map((p) => [p.lat, p.lng])).toEqual([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

describe('the school', () => {
  // School about 2.2 km past D, on the same road.
  const school = { lat: 12.97, lng: 77.65 };

  it('ends the morning when the route has no stop there', () => {
    const plan = buildPlan(route, 'TO_SCHOOL', 1, school);

    expect(plan.schoolStopId).toBe('school');
    const last = plan.stops[plan.stops.length - 1];
    expect(last).toMatchObject({ id: 'school', isSchool: true });
    // D is 20 min of driving; the school ~2.2 km on, x1.35 at 22 km/h: 8 more. Waits
    // at B, C and D: 3.
    expect(last.planned).toBe(20 + 8 + 3);
  });

  it('starts the afternoon, with every house counted from it', () => {
    const plan = buildPlan(route, 'FROM_SCHOOL', 1, school);

    expect(plan.stops.map((s) => [s.id, s.planned])).toEqual([['school', 0], ['D', 8], ['C', 14], ['B', 22], ['A', 31]]);
  });

  it('uses the routed drive when the stored road runs on to the school', () => {
    const road = [...route.stops.map((s) => ({ lat: s.lat, lng: s.lng })), school];
    const plan = buildPlan({ ...route, geometry: encode(road), estimatedDuration: 26 }, 'TO_SCHOOL', 0, school);

    expect(plannedMinutes(plan, 'school')).toBe(26);
  });

  it('is the last stop when the route already ends there', () => {
    const plan = buildPlan(route, 'TO_SCHOOL', 0, { lat: 12.97, lng: 77.6301 });

    expect(plan.schoolStopId).toBe('D');
    expect(plan.stops.map((s) => s.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('is left out when its location is not known', () => {
    expect(buildPlan(route, 'TO_SCHOOL', 0, null).schoolStopId).toBeNull();
  });
});
