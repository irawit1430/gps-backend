const request = require('supertest');

// Mock child_process so npx prisma db push doesn't run during tests
jest.mock('child_process', () => ({
  execSync: jest.fn()
}));

const { app, server, io, prisma } = require('../server');

// Mock Prisma
jest.mock('@prisma/client', () => {
  const mPrismaClient = {
    bus: { findUnique: jest.fn() },
    gpsLog: { create: jest.fn() }
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

// Mock Socket.io emit
jest.spyOn(io, 'emit').mockImplementation(() => {});

describe('POST /api/telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll((done) => {
    if (server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  it('should return 200 and emit location_update on successful telemetry', async () => {
    const mockBus = { id: 1, licensePlate: 'BUS-123' };
    const mockLog = { timestamp: new Date('2023-10-27T10:00:00Z') };

    prisma.bus.findUnique.mockResolvedValue(mockBus);
    prisma.gpsLog.create.mockResolvedValue(mockLog);

    const payload = {
      deviceId: 'DEVICE-001',
      lat: 40.7128,
      lng: -74.0060,
      speed: 45,
      timestamp: '2023-10-27T10:00:00Z'
    };

    const response = await request(app)
      .post('/api/telemetry')
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });

    expect(prisma.bus.findUnique).toHaveBeenCalledWith({ where: { deviceId: 'DEVICE-001' } });
    expect(prisma.gpsLog.create).toHaveBeenCalledWith({
      data: {
        busId: 1,
        lat: 40.7128,
        lng: -74.0060,
        speed: 45,
        timestamp: '2023-10-27T10:00:00Z'
      }
    });

    expect(io.emit).toHaveBeenCalledWith('location_update', {
      busId: 1,
      licensePlate: 'BUS-123',
      lat: 40.7128,
      lng: -74.0060,
      speed: 45,
      timestamp: mockLog.timestamp
    });
  });

  it('should return 404 if bus is not found', async () => {
    prisma.bus.findUnique.mockResolvedValue(null);

    const payload = {
      deviceId: 'UNKNOWN-DEVICE',
      lat: 40.7128,
      lng: -74.0060
    };

    const response = await request(app)
      .post('/api/telemetry')
      .send(payload);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Bus not found' });
    expect(prisma.gpsLog.create).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });

  it('should return 500 if database query fails', async () => {
    prisma.bus.findUnique.mockRejectedValue(new Error('Database error'));

    const payload = {
      deviceId: 'DEVICE-001',
      lat: 40.7128,
      lng: -74.0060
    };

    const response = await request(app)
      .post('/api/telemetry')
      .send(payload);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Database error' });
    expect(prisma.gpsLog.create).not.toHaveBeenCalled();
    expect(io.emit).not.toHaveBeenCalled();
  });
});
