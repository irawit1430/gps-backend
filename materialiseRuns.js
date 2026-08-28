// Turns runs into the trips that already exist, for the next few days.
//
// Rolling window rather than a whole term: the trip table stays small, a schedule
// change takes effect almost immediately, and an edit never has to retroactively
// rewrite months of generated rows. Several days rather than one so a VM that is down
// overnight does not cost a school its morning.
//
// Re-running is free. Trip has a unique on (runId, serviceDate), so a second pass, a
// retry after a crash, or two overlapping passes all produce exactly one trip per run
// per day. That constraint is the safety property — this code does not carefully
// avoid duplicates, it is structurally unable to create them.
//
// It only ever CREATES. An exception saved for a date that already materialised
// reaches forward and edits that trip from the endpoint that saved it; the
// materialiser never reaches backward. Otherwise a second pass would silently undo a
// hand-edit, and "the materialiser rewrote my change" is a bug nobody can see.

const { resolveRunOnDate, departureAt, ymd } = require('./runSchedule');

function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Returns { created, skipped, crewless } — crewless is the one worth alerting on: a
// run with no bus or driver cannot become a trip, because Trip requires both. That is
// an operational gap the office has to close, not an error to swallow.
async function materialiseRuns(prisma, { days = 3, now = new Date(), logger } = {}) {
  const today = startOfLocalDay(now);
  const dates = Array.from({ length: days }, (_, i) => addDays(today, i));
  const from = dates[0];
  const to = dates[dates.length - 1];

  const runs = await prisma.run.findMany({
    where: { active: true, startDate: { lte: to }, endDate: { gte: from } },
    include: { route: { select: { schoolId: true } } },
  });
  if (runs.length === 0) return { created: 0, skipped: 0, crewless: 0 };

  const runIds = runs.map((r) => r.id);
  const [exceptions, closures] = await Promise.all([
    prisma.runException.findMany({
      where: { runId: { in: runIds }, date: { gte: from, lte: to } },
    }),
    prisma.calendarDay.findMany({ where: { date: { gte: from, lte: to } } }),
  ]);

  const exceptionFor = new Map();
  for (const e of exceptions) exceptionFor.set(`${e.runId}::${ymd(e.date)}`, e);

  // A school-specific closure beats a platform one for the same date: a school that
  // has explicitly said something about a day has overridden the default.
  const closureFor = new Map();
  for (const c of closures) {
    const key = `${c.schoolId || '*'}::${ymd(c.date)}`;
    closureFor.set(key, c);
  }
  const closureOn = (schoolId, day) =>
    closureFor.get(`${schoolId}::${day}`) || closureFor.get(`*::${day}`) || null;

  const rows = [];
  const crewlessRuns = new Map();
  let skipped = 0;
  let crewless = 0;

  for (const date of dates) {
    const day = ymd(date);
    for (const run of runs) {
      const verdict = resolveRunOnDate(
        run,
        date,
        exceptionFor.get(`${run.id}::${day}`) || null,
        closureOn(run.route?.schoolId, day)
      );
      if (!verdict.operates) {
        skipped += 1;
        continue;
      }
      // Trip requires a bus and a driver. A run missing either cannot produce one,
      // and silently generating nothing is how a school discovers at 07:00 that a
      // route has no bus. Counted and logged so it surfaces before the morning.
      if (!run.busId || !run.driverId) {
        crewless += 1;
        crewlessRuns.set(run.id, { run, firstDate: crewlessRuns.get(run.id)?.firstDate || day });
        logger?.warn(
          { runId: run.id, runName: run.name, date: day },
          'Run cannot materialise: no bus or driver assigned'
        );
        continue;
      }
      rows.push({
        runId: run.id,
        serviceDate: date,
        routeId: run.routeId,
        busId: run.busId,
        driverId: run.driverId,
        direction: run.direction,
        status: 'PLANNED',
        scheduledStart: departureAt(date, verdict.departure),
      });
    }
  }

  // A run that was saved correctly and LATER lost its crew — bus deleted, driver
  // reassigned — is the dangerous case. Nothing about that action touches the run, so
  // one that has worked for six weeks silently stops producing trips, and a log line
  // nobody reads is the same as silence. The first signal would be a stop full of
  // children at 07:15.
  if (crewlessRuns.size > 0) await warnSchoolsAboutCrewlessRuns(prisma, crewlessRuns, logger);

  if (rows.length === 0) return { created: 0, skipped, crewless };

  // skipDuplicates rather than checking first: the unique constraint is the arbiter,
  // and a check-then-create would race two overlapping passes.
  const { count } = await prisma.trip.createMany({ data: rows, skipDuplicates: true });
  return { created: count, skipped, crewless };
}

// Tells the school admins, once a day per run, rather than logging into the void.
// Deduped by looking for the same notification already raised today: the materialiser
// runs every four hours, and six identical alerts a day is how an admin learns to
// ignore the one that matters.
async function warnSchoolsAboutCrewlessRuns(prisma, crewlessRuns, logger) {
  try {
    const since = startOfLocalDay(new Date());
    for (const { run, firstDate } of crewlessRuns.values()) {
      const schoolId = run.route?.schoolId;
      if (!schoolId) continue;

      const title = `Run has no bus or driver`;
      const message =
        `"${run.name}" cannot run on ${firstDate} — ` +
        `${!run.busId && !run.driverId ? "no bus and no driver are" : !run.busId ? "no bus is" : "no driver is"} assigned. ` +
        `No trip will be created until one is.`;

      const admins = await prisma.user.findMany({
        where: { schoolId, role: { in: ["SCHOOL_ADMIN", "SUPER_ADMIN"] } },
        select: { id: true },
      });
      if (admins.length === 0) continue;

      const already = await prisma.notification.findFirst({
        where: { userId: { in: admins.map((a) => a.id) }, message, createdAt: { gte: since } },
        select: { id: true },
      });
      if (already) continue;

      await prisma.notification.createMany({
        data: admins.map((a) => ({ userId: a.id, title, message, type: "SYSTEM" })),
      });
      logger?.info({ runId: run.id, schoolId, admins: admins.length }, "Warned school about a crewless run");
    }
  } catch (err) {
    // Never let the alert path fail the materialisation it is reporting on.
    logger?.error({ err: err.message }, "Failed to warn about crewless runs");
  }
}

module.exports = { materialiseRuns, startOfLocalDay, addDays };
