const gate = require('../gpsWriteGate');
const config = require('../config');

const BUS = 'bus-1';
const TRIP = 'trip-1';
const PARKED_MS = config.GPS_PARKED_INTERVAL_MIN * 60_000;

describe('gpsWriteGate', () => {
  let now;

  beforeEach(() => {
    gate.clear();
    now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => jest.restoreAllMocks());

  const tick = (ms) => { now += ms; };

  // The whole point of the gate: trip data is never sampled away. Playback and
  // segment history read this column, so a dropped fix is a hole in the track.
  it('always persists a fix belonging to a trip, however fast they arrive', () => {
    for (let i = 0; i < 50; i++) {
      expect(gate.shouldPersist(BUS, TRIP, 0)).toBe(true);
      tick(3000);
    }
  });

  it('always persists a moving bus even with no trip', () => {
    for (let i = 0; i < 20; i++) {
      expect(gate.shouldPersist(BUS, null, 40)).toBe(true);
      tick(3000);
    }
  });

  it('throttles a parked, trip-less bus to one row per interval', () => {
    expect(gate.shouldPersist(BUS, null, 0)).toBe(true); // first fix always stored

    tick(8000);
    expect(gate.shouldPersist(BUS, null, 0)).toBe(false);
    tick(8000);
    expect(gate.shouldPersist(BUS, null, 0)).toBe(false);

    tick(PARKED_MS);
    expect(gate.shouldPersist(BUS, null, 0)).toBe(true);
  });

  // A stationary GPS unit reports a few km/h of jitter. Treating that as movement
  // would defeat the throttle entirely and store every packet again.
  it('treats sub-threshold jitter as parked', () => {
    expect(gate.shouldPersist(BUS, null, 0)).toBe(true);
    tick(8000);
    expect(gate.shouldPersist(BUS, null, config.GPS_MOVING_SPEED_KPH - 0.1)).toBe(false);
  });

  it('starts a trip mid-park and stores immediately, without waiting out the interval', () => {
    expect(gate.shouldPersist(BUS, null, 0)).toBe(true);
    tick(8000);
    expect(gate.shouldPersist(BUS, null, 0)).toBe(false);
    // driver taps start; the very next packet must be recorded
    expect(gate.shouldPersist(BUS, TRIP, 0)).toBe(true);
  });

  it('throttles each bus independently', () => {
    expect(gate.shouldPersist('bus-a', null, 0)).toBe(true);
    expect(gate.shouldPersist('bus-b', null, 0)).toBe(true);
    tick(8000);
    expect(gate.shouldPersist('bus-a', null, 0)).toBe(false);
    expect(gate.shouldPersist('bus-b', null, 0)).toBe(false);
  });

  it('refuses a fix with no bus', () => {
    expect(gate.shouldPersist(null, TRIP, 50)).toBe(false);
  });

  // The measured production shape: ~8s packets, parked all day.
  it('cuts a parked day from ~10,000 rows to a couple of hundred', () => {
    let stored = 0;
    for (let i = 0; i < 10_800; i++) { // 24h at 8s
      if (gate.shouldPersist(BUS, null, 0)) stored++;
      tick(8000);
    }
    expect(stored).toBeLessThan(300);
    expect(stored).toBeGreaterThan(0);
  });
});
