const axios = require('axios');
const { simulateFleet } = require('./simulate');

jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => {
      return {};
    })
  };
});

jest.mock('axios');

describe('simulateFleet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(global, 'setTimeout').mockImplementation((cb) => {
      cb();
      return 0;
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should send telemetry for each bus for a single iteration', async () => {
    const buses = [
      { deviceId: 'bus-1' },
      { deviceId: 'bus-2' }
    ];

    axios.post.mockResolvedValue({});

    await simulateFleet(buses, 1);

    expect(axios.post).toHaveBeenCalledTimes(2);

    // Check first call arguments
    const firstCallArgs = axios.post.mock.calls[0];
    expect(firstCallArgs[0]).toBe('http://localhost:3000/api/telemetry');
    expect(firstCallArgs[1]).toMatchObject({
      deviceId: 'bus-1',
      lat: expect.any(Number),
      lng: expect.any(Number),
      speed: expect.any(Number),
      timestamp: expect.any(String)
    });
  });

  it('should log an error if telemetry fails', async () => {
    const buses = [
      { deviceId: 'bus-1' }
    ];

    axios.post.mockRejectedValue(new Error('Network Error'));

    await simulateFleet(buses, 1);

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[Error] Failed to send telemetry for bus-1'));
  });

  it('should run multiple iterations if specified', async () => {
    const buses = [
      { deviceId: 'bus-1' }
    ];

    axios.post.mockResolvedValue({});

    await simulateFleet(buses, 3);

    expect(axios.post).toHaveBeenCalledTimes(3);
  });
});
