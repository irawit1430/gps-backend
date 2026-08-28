// Decides whether a run operates on a given date, and at what time.
//
// ONE resolver, called by both the materialiser and the preview endpoint. The
// materialiser acts on the verdict; the preview reports it. Two implementations of
// this precedence would agree at first and diverge quietly, and the first symptom
// would be an admin trusting a screen that is wrong — which is the failure the
// preview exists to prevent.
//
// Three layers, most specific first:
//
//   1. A run exception wins over everything. REMOVED means no trip whatever the rest
//      says; ADDED means a trip even on a weekday the pattern excludes, which is how
//      a one-off Saturday service is expressed.
//   2. Then the shared calendar — a closure for that date, for this school or
//      platform-wide, suppresses the run. This is the holiday path, and it is why a
//      festival is one row rather than several hundred.
//   3. Then the weekday pattern.
//
// That ordering is what makes exam days work: a school can be open on a date nobody
// else is, with its 07:15 shifted to 09:00, and nothing about the weekly pattern is
// edited to achieve it.

const WEEKDAY_FIELD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const STATUS = {
  RUNNING: 'RUNNING',
  SHIFTED: 'SHIFTED',
  ADDED_EXCEPTION: 'ADDED_EXCEPTION',
  CANCELLED_EXCEPTION: 'CANCELLED_EXCEPTION',
  CLOSED_SCHOOL: 'CLOSED_SCHOOL',
  CLOSED_PLATFORM: 'CLOSED_PLATFORM',
  OFF_PATTERN: 'OFF_PATTERN',
  OUT_OF_WINDOW: 'OUT_OF_WINDOW',
  INACTIVE: 'INACTIVE',
};

// Only these produce a trip. Everything else is a reason there isn't one.
const OPERATES = new Set([STATUS.RUNNING, STATUS.SHIFTED, STATUS.ADDED_EXCEPTION]);

// Date-only comparison. Everything here is a calendar day in the school's timezone,
// which is the server's — TZ is pinned in ecosystem.config.js precisely so this is
// the local day and not a UTC one starting at 05:30 IST.
function ymd(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// run:        a Run row
// date:       the service date being considered
// exception:  that run's RunException for this date, or null
// closure:    a CalendarDay covering this date (school-specific preferred), or null
//
// Returns { operates, status, reason, departure } — a verdict, never a bare boolean,
// because "Thursday is missing" and "Thursday is missing because Diwali" are
// different screens and the client must not have to re-derive which.
function resolveRunOnDate(run, date, exception, closure) {
  const day = ymd(date);

  if (!run.active) {
    return verdict(STATUS.INACTIVE, 'Run is not active', null);
  }
  if (day < ymd(run.startDate) || day > ymd(run.endDate)) {
    return verdict(STATUS.OUT_OF_WINDOW, 'Outside this run’s dates', null);
  }

  // 1. The run's own exception outranks everything, including a platform closure —
  //    an ADDED exception is someone deliberately running on a day the fleet is shut.
  if (exception) {
    if (exception.type === 'REMOVED') {
      return verdict(STATUS.CANCELLED_EXCEPTION, exception.reason || 'Cancelled for this date', null);
    }
    return verdict(
      exception.departure ? STATUS.SHIFTED : STATUS.ADDED_EXCEPTION,
      exception.reason || 'Added for this date',
      exception.departure || run.departure
    );
  }

  // 2. Shared closure.
  if (closure && closure.closed) {
    return verdict(
      closure.schoolId ? STATUS.CLOSED_SCHOOL : STATUS.CLOSED_PLATFORM,
      closure.reason,
      null
    );
  }

  // 3. The weekly pattern.
  if (!run[WEEKDAY_FIELD[new Date(date).getDay()]]) {
    return verdict(STATUS.OFF_PATTERN, 'Does not run on this weekday', null);
  }

  return verdict(STATUS.RUNNING, null, run.departure);
}

function verdict(status, reason, departure) {
  return { operates: OPERATES.has(status), status, reason, departure };
}

// "07:15" on a given date, in the server's timezone. Kept together with the resolver
// because the string format and its interpretation are one decision: parsing it
// somewhere else is how a departure ends up 5.5 hours out.
function departureAt(date, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

module.exports = { resolveRunOnDate, departureAt, ymd, STATUS, OPERATES };
