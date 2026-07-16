const request = require('supertest');

// Variables for jest.mock must start with `mock`
const mockPrismaClient = {
  emergencyAlert: {
    create: jest.fn(),
  },
  $disconnect: jest.fn(),
};
jest.mock('@prisma/client', () => {
  return { PrismaClient: jest.fn(() => mockPrismaClient) };
});

const mockIoServer = {
  emit: jest.fn(),
  on: jest.fn(),
};
jest.mock('socket.io', () => {
  return { Server: jest.fn(() => mockIoServer) };
});

const { app } = require('../server');

describe('POST /api/alerts/sos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully create an SOS alert and emit it via websocket', async () => {
    const mockAlertData = {
      schoolId: 'school-123',
      senderId: 'driver-456',
      message: 'Bus broken down',
      tripId: 'trip-789'
    };

    const mockCreatedAlert = {
      id: 'alert-abc',
      ...mockAlertData,
      type: 'DRIVER_SOS',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    };

    mockPrismaClient.emergencyAlert.create.mockResolvedValue(mockCreatedAlert);

    const response = await request(app)
      .post('/api/alerts/sos')
      .send(mockAlertData)
      .expect('Content-Type', /json/)
      .expect(200);

    expect(mockPrismaClient.emergencyAlert.create).toHaveBeenCalledTimes(1);
    expect(mockPrismaClient.emergencyAlert.create).toHaveBeenCalledWith({
      data: {
        schoolId: mockAlertData.schoolId,
        senderId: mockAlertData.senderId,
        type: 'DRIVER_SOS',
        message: mockAlertData.message,
        tripId: mockAlertData.tripId,
        status: 'ACTIVE'
      }
    });

    expect(mockIoServer.emit).toHaveBeenCalledTimes(1);
    expect(mockIoServer.emit).toHaveBeenCalledWith('emergency_alert', mockCreatedAlert);
    expect(response.body).toEqual(mockCreatedAlert);
  });

  it('should handle internal server errors correctly', async () => {
    const mockAlertData = {
      schoolId: 'school-123',
      senderId: 'driver-456',
      message: 'Bus broken down',
      tripId: 'trip-789'
    };

    const mockError = new Error('Database connection failed');
    mockPrismaClient.emergencyAlert.create.mockRejectedValue(mockError);

    const response = await request(app)
      .post('/api/alerts/sos')
      .send(mockAlertData)
      .expect('Content-Type', /json/)
      .expect(500);

    expect(response.body).toHaveProperty('error', mockError.message);
    expect(mockIoServer.emit).not.toHaveBeenCalled();
  });
});
