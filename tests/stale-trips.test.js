const { sweepUnstartedTrips, cancelUnstartedTrips, MAX_PER_PASS } = require('../staleTrips');
const config = require('../config');

const NOW = new Date('2026-09-22T12:00:00Z');

const mockPrisma = () => ({
  trip: {
    findMany: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
  },
});

describe('cancelUnstartedTrips', () => {
  it('cancels PLANNED trips whose departure is more than staleHours gone', async () => {
    const prisma = mockPrisma();
    const cancelled = [{ id: 't1', status: 'CANCELLED', route: { name: 'R1', schoolId: 's1' } }];
    prisma.trip.findMany
      .mockResolvedValueOnce([{ id: 't1' }])
      .mockResolvedValueOnce(cancelled);

    const result = await cancelUnstartedTrips(prisma, { staleHours: 12, now: NOW });

    expect(prisma.trip.findMany).toHaveBeenNthCalledWith(1, {
      where: { status: 'PLANNED', scheduledStart: { lt: new Date('2026-09-22T00:00:00Z') } },
      select: { id: true },
      take: MAX_PER_PASS,
    });
    expect(result).toBe(cancelled);
  });

  it('only cancels trips that are still PLANNED when it writes', async () => {
    // A driver starting the trip between the read and the write must win.
    const prisma = mockPrisma();
    prisma.trip.findMany.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]).mockResolvedValueOnce([]);

    await cancelUnstartedTrips(prisma, { staleHours: 12, now: NOW });

    expect(prisma.trip.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['t1', 't2'] }, status: 'PLANNED' },
      data: { status: 'CANCELLED' },
    });
  });

  it('reports only the trips this pass actually cancelled', async () => {
    const prisma = mockPrisma();
    prisma.trip.findMany.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]).mockResolvedValueOnce([]);

    await cancelUnstartedTrips(prisma, { staleHours: 12, now: NOW });

    expect(prisma.trip.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: { in: ['t1', 't2'] }, status: 'CANCELLED' },
    }));
  });

  it('never touches an unscheduled trip, a running one, or anything recent', async () => {
    // The filter is the whole safety property, so assert it exactly: PLANNED only, and
    // only with a scheduledStart older than the cutoff (null never satisfies `lt`).
    const prisma = mockPrisma();
    prisma.trip.findMany.mockResolvedValueOnce([]);

    const result = await cancelUnstartedTrips(prisma, { staleHours: 12, now: NOW });

    const { where } = prisma.trip.findMany.mock.calls[0][0];
    expect(where.status).toBe('PLANNED');
    expect(where.scheduledStart).toEqual({ lt: new Date('2026-09-22T00:00:00Z') });
    expect(prisma.trip.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('sweepUnstartedTrips', () => {
  it('is off unless STALE_TRIP_SWEEP is set', () => {
    // The sweep changes data one way and its first pass covers every leftover trip since
    // go-live, so deploying it must not start it.
    expect(config.STALE_TRIP_SWEEP).toBe(false);
  });

  it('when off, changes nothing and reports what it would cancel', async () => {
    const prisma = mockPrisma();
    prisma.trip.count.mockResolvedValue(37);

    const result = await sweepUnstartedTrips(prisma, { enabled: false, staleHours: 12, now: NOW });

    expect(result).toEqual({ cancelled: [], wouldCancel: 37 });
    expect(prisma.trip.count).toHaveBeenCalledWith({
      where: { status: 'PLANNED', scheduledStart: { lt: new Date('2026-09-22T00:00:00Z') } },
    });
    expect(prisma.trip.updateMany).not.toHaveBeenCalled();
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });

  it('when on, cancels', async () => {
    const prisma = mockPrisma();
    const cancelled = [{ id: 't1', status: 'CANCELLED' }];
    prisma.trip.findMany.mockResolvedValueOnce([{ id: 't1' }]).mockResolvedValueOnce(cancelled);

    const result = await sweepUnstartedTrips(prisma, { enabled: true, staleHours: 12, now: NOW });

    expect(result).toEqual({ cancelled, wouldCancel: 0 });
    expect(prisma.trip.updateMany).toHaveBeenCalled();
  });
});
