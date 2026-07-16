const request = require('supertest');
const { app, prisma } = require('./server');

// Mock @prisma/client
jest.mock('@prisma/client', () => {
  const mPrismaClient = {
    bus: {
      findMany: jest.fn()
    }
  };
  return {
    PrismaClient: jest.fn(() => mPrismaClient)
  };
});

describe('GET /api/schools/:schoolId/buses', () => {
  beforeEach(() => {
    // Clear all instances and calls to constructor and all methods:
    jest.clearAllMocks();
  });

  it('should return a list of buses for a valid schoolId', async () => {
    const mockBuses = [
      { id: '1', licensePlate: 'ABC-123', schoolId: 'school-1', gpsLogs: [] },
      { id: '2', licensePlate: 'XYZ-987', schoolId: 'school-1', gpsLogs: [] }
    ];
    prisma.bus.findMany.mockResolvedValue(mockBuses);

    const response = await request(app).get('/api/schools/school-1/buses');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockBuses);
    expect(prisma.bus.findMany).toHaveBeenCalledWith({
      where: { schoolId: 'school-1' },
      include: { gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 } }
    });
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(1);
  });

  it('should return an empty array if no buses are found', async () => {
    prisma.bus.findMany.mockResolvedValue([]);

    const response = await request(app).get('/api/schools/school-2/buses');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(prisma.bus.findMany).toHaveBeenCalledWith({
      where: { schoolId: 'school-2' },
      include: { gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 } }
    });
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(1);
  });

  it('should return a 500 status if prisma throws an error', async () => {
    const errorMessage = 'Database connection failed';
    prisma.bus.findMany.mockRejectedValue(new Error(errorMessage));

    const response = await request(app).get('/api/schools/school-error/buses');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: errorMessage });
    expect(prisma.bus.findMany).toHaveBeenCalledWith({
      where: { schoolId: 'school-error' },
      include: { gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 } }
    });
    expect(prisma.bus.findMany).toHaveBeenCalledTimes(1);
  });
});
