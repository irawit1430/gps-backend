const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: {
      update: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

describe('PATCH /api/trips/:tripId/status', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: 1, role: 'ADMIN', schoolId: 'school-1' }, process.env.JWT_SECRET || 'super-secret');
    jest.useFakeTimers().setSystemTime(new Date('2023-01-01T10:00:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['ON_SCHEDULE', { status: 'ON_SCHEDULE', startTime: new Date('2023-01-01T10:00:00.000Z') }],
    ['COMPLETED', { status: 'COMPLETED', endTime: new Date('2023-01-01T10:00:00.000Z') }],
    ['DELAYED', { status: 'DELAYED' }]
  ])('should update trip status to %s and set appropriate dates', async (status, expectedData) => {
    const mockTrip = { id: 'trip-1', ...expectedData };
    prisma.trip.update.mockResolvedValue(mockTrip);

    const res = await request(app)
      .patch('/api/trips/trip-1/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(mockTrip)));
    expect(prisma.trip.update).toHaveBeenCalledWith({
      where: { id: 'trip-1' },
      data: expectedData
    });
  });

  it('should return 500 when database throws an error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    prisma.trip.update.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .patch('/api/trips/trip-1/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ON_SCHEDULE' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    jest.restoreAllMocks();
  });
});
