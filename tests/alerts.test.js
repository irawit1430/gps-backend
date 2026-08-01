const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    emergencyAlert: {
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma, io } = require('../server');

describe('POST /api/alerts/sos', () => {
  let token;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    token = jwt.sign({ id: 1, role: 'DRIVER', schoolId: 'school-1' }, process.env.JWT_SECRET);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 if unauthorized', async () => {
    const res = await request(app).post('/api/alerts/sos').send({});
    expect(res.status).toBe(401);
  });

  it('should create an SOS alert and emit a socket event', async () => {
    const mockAlert = {
      id: 'alert-1',
      schoolId: 'school-1',
      senderId: 'driver-1',
      type: 'DRIVER_SOS',
      message: 'Help!',
      tripId: 'trip-1',
      status: 'ACTIVE'
    };

    prisma.emergencyAlert.create.mockResolvedValue(mockAlert);
    const ioEmitSpy = jest.spyOn(io, 'emit');

    const res = await request(app)
      .post('/api/alerts/sos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        schoolId: 'school-1',
        senderId: 'driver-1',
        message: 'Help!',
        tripId: 'trip-1'
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockAlert);

    expect(prisma.emergencyAlert.create).toHaveBeenCalledWith({
      data: {
        schoolId: 'school-1',
        senderId: 'driver-1',
        type: 'DRIVER_SOS',
        message: 'Help!',
        tripId: 'trip-1',
        status: 'ACTIVE'
      }
    });

    expect(ioEmitSpy).toHaveBeenCalledWith('emergency_alert', mockAlert);
  });

  it('should return 500 when database throws an error', async () => {
    prisma.emergencyAlert.create.mockRejectedValue(new Error('Database error'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/alerts/sos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        schoolId: 'school-1',
        senderId: 'driver-1',
        message: 'Help!',
        tripId: 'trip-1'
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    consoleSpy.mockRestore();
  });
});
