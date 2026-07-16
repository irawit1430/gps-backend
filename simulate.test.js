const { simulateFleet } = require('./simulate');
const axios = require('axios');

jest.mock('axios');

describe('simulateFleet', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.useFakeTimers();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('should catch error and log when axios.post fails', async () => {
    // Mock axios.post to reject with an error
    axios.post.mockRejectedValue(new Error('Network Error'));

    const mockBuses = [{ deviceId: 'test-device' }];

    // Create a promise for simulateFleet
    const promise = simulateFleet(mockBuses, 1);

    // Fast-forward timers to skip the 5 second sleep
    // Using runAllTimersAsync since we have async operations inside the loop before sleep
    await Promise.resolve(); // Allow the loop and try/catch block to execute

    // The axios request is made, error is caught, and then sleep is called.
    // So we advance timers to resolve sleep.
    jest.runAllTimers();

    await promise;

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:3000/api/telemetry',
      expect.objectContaining({
        deviceId: 'test-device'
      })
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('[Error] Failed to send telemetry for test-device');
  });

  it('should log success when axios.post succeeds', async () => {
    // Mock axios.post to resolve successfully
    axios.post.mockResolvedValue({});

    const mockBuses = [{ deviceId: 'test-device-success' }];

    // Create a promise for simulateFleet
    const promise = simulateFleet(mockBuses, 1);

    await Promise.resolve();
    jest.runAllTimers();

    await promise;

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[Sent] Device: test-device-success'));
  });
});
