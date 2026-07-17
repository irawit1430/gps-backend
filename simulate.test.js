const axios = require('axios');
const { simulateFleet } = require('./simulate');

jest.mock('axios');
jest.mock('@prisma/client', () => {
    return {
        PrismaClient: jest.fn().mockImplementation(() => {
            return {
                school: { create: jest.fn() },
                bus: { create: jest.fn() },
                route: { create: jest.fn() },
                student: { create: jest.fn() },
                gpsLog: { deleteMany: jest.fn() },
                attendanceLog: { deleteMany: jest.fn() },
                studentRouteMapping: { deleteMany: jest.fn() },
                trip: { deleteMany: jest.fn() },
                routeStop: { deleteMany: jest.fn() },
                user: { deleteMany: jest.fn() },
                $disconnect: jest.fn(),
            };
        }),
    };
});

describe('simulateFleet', () => {
    let originalSetTimeout;

    beforeAll(() => {
        // Mock setTimeout to execute immediately
        originalSetTimeout = global.setTimeout;
        global.setTimeout = (cb) => cb();
    });

    afterAll(() => {
        global.setTimeout = originalSetTimeout;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should send telemetry data for each bus', async () => {
        axios.post.mockResolvedValue({});
        const mockBuses = [{ deviceId: 'BUS1' }, { deviceId: 'BUS2' }];

        await simulateFleet(mockBuses, 1);

        expect(axios.post).toHaveBeenCalledTimes(2);

        // Assert the payload of the first call
        expect(axios.post).toHaveBeenNthCalledWith(1, 'http://localhost:3000/api/telemetry', expect.objectContaining({
            deviceId: 'BUS1',
            lat: expect.any(Number),
            lng: expect.any(Number),
            speed: expect.any(Number),
            timestamp: expect.any(String),
        }));

        // Assert the payload of the second call
        expect(axios.post).toHaveBeenNthCalledWith(2, 'http://localhost:3000/api/telemetry', expect.objectContaining({
            deviceId: 'BUS2',
            lat: expect.any(Number),
            lng: expect.any(Number),
            speed: expect.any(Number),
            timestamp: expect.any(String),
        }));
    });

    it('should handle axios errors gracefully', async () => {
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        axios.post.mockRejectedValue(new Error('Network error'));

        const mockBuses = [{ deviceId: 'BUS1' }];

        await simulateFleet(mockBuses, 1);

        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith('[Error] Failed to send telemetry for BUS1');

        consoleErrorSpy.mockRestore();
    });

    it('should run for specified number of iterations', async () => {
        axios.post.mockResolvedValue({});
        const mockBuses = [{ deviceId: 'BUS1' }];

        await simulateFleet(mockBuses, 3);

        expect(axios.post).toHaveBeenCalledTimes(3);
    });
});
