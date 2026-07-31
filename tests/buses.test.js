const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    bus: {
      findMany: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

describe('GET /api/schools/:schoolId/buses', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: 1, role: 'ADMIN', schoolId: 'school-1' }, process.env.JWT_SECRET || 'super-secret');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return a list of formatted buses with active trip info', async () => {
    const mockBuses = [
      {
        id: 1,
        licensePlate: 'BUS-001',
        capacity: 40,
        schoolId: 'school-1',
        trips: [
          {
            status: 'ON_SCHEDULE',
            driver: { name: 'Alice' },
            route: { name: 'Route A' }
          }
        ],
        gpsLogs: [
          { timestamp: '2023-01-01T10:00:00.000Z' }
        ]
      },
      {
        id: 2,
        licensePlate: 'BUS-002',
        capacity: 30,
        schoolId: 'school-1',
        trips: [], // no active trips
        gpsLogs: []
      }
    ];

    prisma.bus.findMany.mockResolvedValue(mockBuses);

    const res = await request(app)
      .get('/api/schools/school-1/buses')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    expect(res.body[0]).toMatchObject({
      id: 1,
      licensePlate: 'BUS-001',
      driverName: 'Alice',
      routeName: 'Route A'
    });

    expect(res.body[1]).toMatchObject({
      id: 2,
      licensePlate: 'BUS-002',
      driverName: 'Unassigned',
      routeName: 'Off-Route'
    });

    expect(prisma.bus.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { schoolId: 'school-1' },
      })
    );
  });

  it('should return 500 when database throws an error', async () => {
    prisma.bus.findMany.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .get('/api/schools/school-1/buses')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
