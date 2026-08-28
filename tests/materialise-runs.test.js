const { materialiseRuns } = require('../materialiseRuns');

// Monday 2026-11-16, so a Mon–Fri run operates on day 0 and 1, not on the Saturday.
const MONDAY = new Date('2026-11-16T06:00:00');

const run = (over = {}) => ({
  id: 'run-1', routeId: 'route-1', busId: 'bus-1', driverId: 'driver-1',
  name: 'Morning pickup', direction: 'TO_SCHOOL', departure: '07:15',
  active: true,
  startDate: new Date('2026-06-01T00:00:00'),
  endDate: new Date('2027-03-31T00:00:00'),
  sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false,
  route: { schoolId: 'school-1' },
  ...over,
});

const mockPrisma = (runs, exceptions = [], closures = []) => ({
  run: { findMany: jest.fn().mockResolvedValue(runs) },
  runException: { findMany: jest.fn().mockResolvedValue(exceptions) },
  calendarDay: { findMany: jest.fn().mockResolvedValue(closures) },
  trip: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
});

describe('materialiseRuns', () => {
  it('creates one trip per operating day in the window', async () => {
    const p = mockPrisma([run()]);
    p.trip.createMany.mockResolvedValue({ count: 3 });

    const res = await materialiseRuns(p, { days: 3, now: MONDAY });

    expect(res.created).toBe(3);
    const rows = p.trip.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(3); // Mon, Tue, Wed
    expect(rows[0]).toMatchObject({
      runId: 'run-1', busId: 'bus-1', driverId: 'driver-1',
      direction: 'TO_SCHOOL', status: 'PLANNED',
    });
  });

  // The materialiser must never be the thing that avoids duplicates by checking.
  it('relies on the unique constraint rather than a pre-check', async () => {
    const p = mockPrisma([run()]);
    await materialiseRuns(p, { days: 1, now: MONDAY });

    expect(p.trip.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(p.trip.findMany).toBeUndefined(); // no read-before-write at all
  });

  it('sets scheduledStart to the local departure time, not midnight', async () => {
    const p = mockPrisma([run()]);
    await materialiseRuns(p, { days: 1, now: MONDAY });

    const start = p.trip.createMany.mock.calls[0][0].data[0].scheduledStart;
    expect(start.getHours()).toBe(7);
    expect(start.getMinutes()).toBe(15);
  });

  it('skips days the weekday pattern excludes', async () => {
    // Friday, so the 3-day window covers Fri, Sat, Sun — only Friday operates.
    const p = mockPrisma([run()]);
    await materialiseRuns(p, { days: 3, now: new Date('2026-11-20T06:00:00') });

    expect(p.trip.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('a platform closure suppresses every school', async () => {
    const p = mockPrisma([run()], [], [
      { schoolId: null, date: new Date('2026-11-16T00:00:00'), closed: true, reason: 'Diwali' },
    ]);
    await materialiseRuns(p, { days: 1, now: MONDAY });

    expect(p.trip.createMany).not.toHaveBeenCalled();
  });

  // A school that has said something explicit about a date has overridden the default.
  it('a school closure takes precedence over the platform row for that date', async () => {
    const p = mockPrisma([run()], [], [
      { schoolId: null, date: new Date('2026-11-16T00:00:00'), closed: true, reason: 'Platform' },
      { schoolId: 'school-1', date: new Date('2026-11-16T00:00:00'), closed: false, reason: 'We are open' },
    ]);
    await materialiseRuns(p, { days: 1, now: MONDAY });

    expect(p.trip.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('an exception shifts the departure without touching the pattern', async () => {
    const p = mockPrisma([run()], [
      { runId: 'run-1', date: new Date('2026-11-16T00:00:00'), type: 'ADDED', departure: '09:00', reason: 'Exam' },
    ]);
    await materialiseRuns(p, { days: 1, now: MONDAY });

    const start = p.trip.createMany.mock.calls[0][0].data[0].scheduledStart;
    expect(start.getHours()).toBe(9);
  });

  // Silently generating nothing is how a school finds out at 07:00 that a route has
  // no bus. It has to be counted and logged.
  it('reports a run with no crew instead of silently producing nothing', async () => {
    const warn = jest.fn();
    const p = mockPrisma([run({ busId: null })]);

    const res = await materialiseRuns(p, { days: 1, now: MONDAY, logger: { warn } });

    expect(res.crewless).toBe(1);
    expect(res.created).toBe(0);
    expect(warn).toHaveBeenCalled();
    expect(p.trip.createMany).not.toHaveBeenCalled();
  });

  it('does nothing when no runs exist', async () => {
    const p = mockPrisma([]);
    const res = await materialiseRuns(p, { days: 3, now: MONDAY });

    expect(res).toEqual({ created: 0, skipped: 0, crewless: 0 });
    expect(p.trip.createMany).not.toHaveBeenCalled();
  });

  it('ignores an inactive run', async () => {
    const p = mockPrisma([run({ active: false })]);
    // findMany is mocked so the where clause is not applied; the resolver must also refuse.
    await materialiseRuns(p, { days: 1, now: MONDAY });
    expect(p.trip.createMany).not.toHaveBeenCalled();
  });
});
