// Whole-system alarms: the failures that hit every school at once and that no single
// school's screen would reveal.
//
//  - GPS intake stopped. Trips are running but no bus anywhere has delivered a fix for
//    SYSTEM_GPS_SILENCE_MINUTES. A per-bus alert (darkBuses.js) fires bus by bus to each
//    school; this is the case where the cause is ours: the telemetry route rejecting
//    everything after a config change, the tracker port closed by a firewall edit, the
//    phone key scheme broken. Every parent's map freezes at once.
//  - Push failing. Of the pushes attempted in the last SYSTEM_PUSH_WINDOW_MINUTES, at
//    least SYSTEM_PUSH_FAIL_RATE failed (and enough were attempted to mean something).
//    A revoked Firebase key or the wrong project fails every send while registrations
//    keep succeeding, so nothing else notices.
//
// Each alarm tells super admins once when it starts and once when it clears, and logs at
// error level so a log-based alert can hang off it too. In memory: the counters are
// about this process, and a restart starts the GPS clock afresh rather than alarming on
// the silence of its own downtime.

const state = {
  startedAt: Date.now(),
  lastFixAt: null,
  pushes: [], // { at, accepted, failed, codes }
  open: new Map(), // check → { since, detail }
};

function noteFix(at = Date.now()) {
  if (!state.lastFixAt || at > state.lastFixAt) state.lastFixAt = at;
}

// One send's outcome: how many devices took it and how many did not, and why not.
function notePush({ accepted = 0, failed = 0, codes = [] }, at = Date.now()) {
  if (!accepted && !failed) return;
  state.pushes.push({ at, accepted, failed, codes });
  if (state.pushes.length > 10_000) state.pushes.splice(0, state.pushes.length - 10_000);
}

function pushWindow(now, windowMinutes) {
  const from = now - windowMinutes * 60_000;
  state.pushes = state.pushes.filter((p) => p.at >= from);
  const tally = { accepted: 0, failed: 0, codes: new Map() };
  for (const p of state.pushes) {
    tally.accepted += p.accepted;
    tally.failed += p.failed;
    for (const c of p.codes) tally.codes.set(c, (tally.codes.get(c) || 0) + 1);
  }
  const top = [...tally.codes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return { accepted: tally.accepted, failed: tally.failed, topReason: top };
}

function snapshot({ now = Date.now(), pushWindowMinutes }) {
  return {
    since: new Date(state.startedAt).toISOString(),
    lastGpsFixAt: state.lastFixAt ? new Date(state.lastFixAt).toISOString() : null,
    push: { windowMinutes: pushWindowMinutes, ...pushWindow(now, pushWindowMinutes) },
    alarms: [...state.open.entries()].map(([check, a]) => ({ check, since: new Date(a.since).toISOString(), detail: a.detail })),
  };
}

// notify({ check, status: 'DOWN' | 'RECOVERED', title, message }) tells the super admins.
async function sweepSystemHealth(prisma, { notify, now = Date.now(), gpsSilenceMinutes, pushWindowMinutes, pushMinAttempts, pushFailRate }) {
  const changes = [];
  const flip = async (check, down, detail, words) => {
    const open = state.open.get(check);
    if (down && !open) {
      state.open.set(check, { since: now, detail });
      changes.push({ check, status: 'DOWN', detail });
      await notify({ check, status: 'DOWN', ...words.down, detail });
    } else if (!down && open) {
      state.open.delete(check);
      const minutes = Math.round((now - open.since) / 60_000);
      changes.push({ check, status: 'RECOVERED', detail });
      await notify({ check, status: 'RECOVERED', ...words.up(minutes), detail });
    }
  };

  if (gpsSilenceMinutes > 0) {
    // At night nothing runs and silence is correct: only a running trip makes it news.
    const running = await prisma.trip.count({ where: { status: { in: ['ON_SCHEDULE', 'DELAYED'] } } });
    const quietSince = state.lastFixAt ?? state.startedAt;
    const quietMinutes = Math.floor((now - quietSince) / 60_000);
    const down = running > 0 && quietMinutes >= gpsSilenceMinutes;
    await flip('GPS_INTAKE', down, { runningTrips: running, quietMinutes }, {
      down: {
        title: 'No GPS from any bus',
        message: `${running} trip${running === 1 ? ' is' : 's are'} running, but no bus has sent a position for ${quietMinutes} minutes. ` +
          'Every parent map has stopped moving. Check the server logs for rejected telemetry and that the tracker port is reachable.',
      },
      up: (m) => ({ title: 'GPS is arriving again', message: `Bus positions are coming in again after about ${m} minutes.` }),
    });
  }

  if (pushWindowMinutes > 0) {
    const { accepted, failed, topReason } = pushWindow(now, pushWindowMinutes);
    const attempts = accepted + failed;
    const down = attempts >= pushMinAttempts && failed / attempts >= pushFailRate;
    const pct = attempts ? Math.round((failed / attempts) * 100) : 0;
    await flip('PUSH_DELIVERY', down, { attempts, failed, topReason }, {
      down: {
        title: 'Push notifications are failing',
        message: `${pct}% of ${attempts} push notifications in the last ${pushWindowMinutes} minutes were not delivered` +
          `${topReason ? ` (most often: ${topReason})` : ''}. Parents are not getting alerts. Check the Firebase key and project.`,
      },
      up: (m) => ({ title: 'Push notifications are working again', message: `Pushes are being delivered again after about ${m} minutes.` }),
    });
  }
  return changes;
}

function reset() {
  state.startedAt = Date.now();
  state.lastFixAt = null;
  state.pushes = [];
  state.open.clear();
}

module.exports = { noteFix, notePush, sweepSystemHealth, snapshot, reset };
