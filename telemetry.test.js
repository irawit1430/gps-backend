const request = require('supertest');

const mockFindUnique = jest.fn();
const mockCreate = jest.fn();

// We must mock the '@prisma/client' module BEFORE requiring server.js
jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => {
      return {
        bus: {
          findUnique: mockFindUnique,
        },
        gpsLog: {
          create: mockCreate,
        }
      };
    })
  };
});

const { app, server } = require('./server');

describe('POST /api/telemetry', () => {
  afterAll((done) => {
    if (server && server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 404 when bus is missing', async () => {
    // Setup the mock to return null for the missing bus case
    mockFindUnique.mockResolvedValue(null);

    const telemetryData = {
      deviceId: 'UNKNOWN_DEVICE_123',
      lat: 18.5204,
      lng: 73.8567,
      speed: 40,
      timestamp: new Date().toISOString()
    };

    const response = await request(app)
      .post('/api/telemetry')
      .send(telemetryData);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Bus not found' });

    // Verify that Prisma was called with correct parameters
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { deviceId: 'UNKNOWN_DEVICE_123' }
    });

    // Verify that a gps log was NOT created
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should create gps log when bus exists', async () => {
    // Setup the mock to return a bus
    const mockBus = { id: 'bus-123', licensePlate: 'MH-12-AB-1001', deviceId: 'TM100-SIM-1' };
    mockFindUnique.mockResolvedValue(mockBus);
    mockCreate.mockResolvedValue({ id: 'log-123', timestamp: new Date() });

    const telemetryData = {
      deviceId: 'TM100-SIM-1',
      lat: 18.5204,
      lng: 73.8567,
      speed: 40,
      timestamp: new Date().toISOString()
    };

    const response = await request(app)
      .post('/api/telemetry')
      .send(telemetryData);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });

    // Verify that Prisma was called with correct parameters
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { deviceId: 'TM100-SIM-1' }
    });

    // Verify that a gps log was created
    expect(mockCreate).toHaveBeenCalled();
  });
});
