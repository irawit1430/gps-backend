const request = require('supertest');

// Mock PrismaClient BEFORE requiring server
jest.mock('@prisma/client', () => {
  const mPrismaClient = {
    bus: {
      findUnique: jest.fn(),
    },
    gpsLog: {
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

const { app } = require('../server');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

describe('POST /api/telemetry', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 500 when a database error occurs (error path)', async () => {
    const mockError = new Error('Database connection failed');
    // Force prisma.bus.findUnique to throw an error
    prisma.bus.findUnique.mockRejectedValue(mockError);

    const payload = {
      deviceId: 'TM-100-TEST',
      lat: 40.7128,
      lng: -74.0060,
      speed: 45,
      timestamp: new Date().toISOString()
    };

    const res = await request(app)
      .post('/api/telemetry')
      .send(payload);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Database connection failed' });
    expect(prisma.bus.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.bus.findUnique).toHaveBeenCalledWith({ where: { deviceId: 'TM-100-TEST' } });
  });

  it('should return 404 when bus is not found', async () => {
    prisma.bus.findUnique.mockResolvedValue(null);

    const payload = {
      deviceId: 'TM-100-UNKNOWN',
      lat: 40.7128,
      lng: -74.0060,
      speed: 45
    };

    const res = await request(app)
      .post('/api/telemetry')
      .send(payload);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Bus not found' });
  });
});
