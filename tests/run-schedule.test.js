const { resolveRunOnDate, departureAt, STATUS } = require('../runSchedule');

// 2026-11-14 is a Saturday; 2026-11-16 a Monday.
const SAT = new Date('2026-11-14T00:00:00');
const MON = new Date('2026-11-16T00:00:00');

const run = (over = {}) => ({
  active: true,
  departure: '07:15',
  startDate: new Date('2026-06-01T00:00:00'),
  endDate: new Date('2027-03-31T00:00:00'),
  sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false,
  ...over,
});

describe('resolveRunOnDate — three layers, most specific first', () => {
  it('runs on a weekday inside the window', () => {
    const v = resolveRunOnDate(run(), MON, null, null);
    expect(v).toMatchObject({ operates: true, status: STATUS.RUNNING, departure: '07:15' });
  });

  it('does not run on a weekday the pattern excludes', () => {
    const v = resolveRunOnDate(run(), SAT, null, null);
    expect(v.operates).toBe(false);
    expect(v.status).toBe(STATUS.OFF_PATTERN);
  });

  // The holiday path: one shared row closes the fleet.
  it('a platform closure suppresses a run that would otherwise operate', () => {
    const v = resolveRunOnDate(run(), MON, null, { closed: true, schoolId: null, reason: 'Diwali' });
    expect(v.operates).toBe(false);
    expect(v.status).toBe(STATUS.CLOSED_PLATFORM);
    expect(v.reason).toBe('Diwali');
  });

  it('distinguishes a school closure from a platform one', () => {
    const v = resolveRunOnDate(run(), MON, null, { closed: true, schoolId: 's1', reason: 'Founder’s Day' });
    expect(v.status).toBe(STATUS.CLOSED_SCHOOL);
  });

  // Exam day: same run, different time, pattern untouched.
  it('an exception with a departure shifts the time and still operates', () => {
    const v = resolveRunOnDate(run(), MON, { type: 'ADDED', departure: '09:00', reason: 'Exam week' }, null);
    expect(v).toMatchObject({ operates: true, status: STATUS.SHIFTED, departure: '09:00', reason: 'Exam week' });
  });

  it('a REMOVED exception cancels a run the pattern includes', () => {
    const v = resolveRunOnDate(run(), MON, { type: 'REMOVED', reason: 'Staff training' }, null);
    expect(v.operates).toBe(false);
    expect(v.status).toBe(STATUS.CANCELLED_EXCEPTION);
  });

  // How a one-off Saturday service is expressed.
  it('an ADDED exception runs on a day the pattern excludes', () => {
    const v = resolveRunOnDate(run(), SAT, { type: 'ADDED', reason: 'Sports day' }, null);
    expect(v.operates).toBe(true);
    expect(v.departure).toBe('07:15');
  });

  // The precedence that makes exam days work at all.
  it('a run exception outranks a platform closure in both directions', () => {
    const closed = { closed: true, schoolId: null, reason: 'Diwali' };

    const added = resolveRunOnDate(run(), MON, { type: 'ADDED', reason: 'Exam' }, closed);
    expect(added.operates).toBe(true);

    const removed = resolveRunOnDate(run(), MON, { type: 'REMOVED', reason: 'No' }, closed);
    expect(removed.status).toBe(STATUS.CANCELLED_EXCEPTION);
  });

  it('does not operate outside its validity window', () => {
    const v = resolveRunOnDate(run(), new Date('2026-05-01T00:00:00'), null, null);
    expect(v.status).toBe(STATUS.OUT_OF_WINDOW);
  });

  it('an inactive run never operates, whatever else says', () => {
    const v = resolveRunOnDate(run({ active: false }), MON, { type: 'ADDED' }, null);
    expect(v.operates).toBe(false);
    expect(v.status).toBe(STATUS.INACTIVE);
  });

  // Every non-operating verdict must say why — a bare date list forces the client to
  // re-derive the reason, which is how preview and reality drift apart.
  it('always explains why a date does not operate', () => {
    for (const v of [
      resolveRunOnDate(run(), SAT, null, null),
      resolveRunOnDate(run(), MON, null, { closed: true, schoolId: null, reason: 'Diwali' }),
      resolveRunOnDate(run(), MON, { type: 'REMOVED', reason: 'Training' }, null),
      resolveRunOnDate(run({ active: false }), MON, null, null),
    ]) {
      expect(v.operates).toBe(false);
      expect(typeof v.reason).toBe('string');
      expect(v.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('departureAt', () => {
  it('builds the departure in local time, not UTC', () => {
    const d = departureAt(MON, '07:15');
    expect(d.getHours()).toBe(7);
    expect(d.getMinutes()).toBe(15);
    expect(d.getDate()).toBe(16);
  });

  it('returns null for a malformed time rather than an Invalid Date', () => {
    expect(departureAt(MON, 'quarter past')).toBeNull();
  });
});
