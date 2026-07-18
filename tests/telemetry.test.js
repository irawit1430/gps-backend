const request = require('supertest');
const { app, prisma } = require('../server');
const io = require('socket.io');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    bus: {
      findUnique: jest.fn(),
    },
    gpsLog: {
      create: jest.fn(),
    }
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('POST /api/telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should process telemetry successfully', async () => {
    const mockBus = {
      id: 1,
      deviceId: 'DEVICE_123',
      licensePlate: 'ABC-123',
      capacity: 40,
      trips: [{
        driver: { name: 'John Doe' },
        route: { name: 'Route A' }
      }]
    };
    prisma.bus.findUnique.mockResolvedValue(mockBus);
    prisma.gpsLog.create.mockResolvedValue({ id: 100, timestamp: new Date() });

    const res = await request(app)
      .post('/api/telemetry')
      .send({ deviceId: 'DEVICE_123', lat: 10.0, lng: 20.0, speed: 50 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.bus.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.gpsLog.create).toHaveBeenCalledTimes(1);
  });
});
