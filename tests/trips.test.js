const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: {
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('POST /api/schools/:schoolId/trips', () => {
  const validToken = jwt.sign(
    { id: 1, role: 'ADMIN', schoolId: 10 },
    process.env.JWT_SECRET || 'super-secret'
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and create a trip with default status PLANNED when data is valid', async () => {
    const mockTrip = {
      id: 1,
      routeId: 5,
      busId: 2,
      driverId: 3,
      status: 'PLANNED',
    };
    prisma.trip.create.mockResolvedValue(mockTrip);

    const res = await request(app)
      .post('/api/schools/10/trips')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ routeId: 5, busId: 2, driverId: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockTrip);
    expect(prisma.trip.create).toHaveBeenCalledWith({
      data: { routeId: 5, busId: 2, driverId: 3, status: 'PLANNED' }
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.trip.create.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .post('/api/schools/10/trips')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ routeId: 5, busId: 2, driverId: 3 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('should return 401 when missing valid JWT token', async () => {
    const res = await request(app)
      .post('/api/schools/10/trips')
      .send({ routeId: 5, busId: 2, driverId: 3 });

    expect(res.status).toBe(401);
  });
});
