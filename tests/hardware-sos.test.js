// A hardware SOS from a tracker not yet assigned to a school was filed under 'unknown'
// and reached super-admins only, never the school whose children were on the trip the
// bus was running. It now falls back to that trip's school.

const net = require('net');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    bus: { findUnique: jest.fn(), update: jest.fn() },
    gpsLog: { create: jest.fn() },
    trip: { findUnique: jest.fn() },
    emergencyAlert: { create: jest.fn() },
    studentRouteMapping: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

jest.mock('../firebase', () => ({
  sendPush: jest.fn(),
  isPushConfigured: jest.fn(() => false),
  syncGpsLogToFirebase: jest.fn(),
  syncEmergencyAlertToFirebase: jest.fn(),
  syncStudentToFirebase: jest.fn(),
  flushFirestore: jest.fn(),
  app: null, db: null, messaging: null,
}));

const { PrismaClient } = require('@prisma/client');
const { startTcpServer } = require('../tcp-server');

const prisma = new PrismaClient();

// Records which rooms each emit went to.
const makeIo = () => {
  const emits = [];
  const target = (rooms) => ({
    to: (more) => target([...rooms, more]),
    emit: (event, payload) => emits.push({ rooms, event, payload }),
  });
  return { emits, to: (room) => target([room]) };
};

// $EPB,EMR,<imei>,NM,<DDMMYYYYhhmmss>,A,lat,N,lng,E,alt,speed,...,regNo*
const sosPacket = (imei) => `$EPB,EMR,${imei},NM,22092026063000,A,12.9716,N,77.5946,E,900,0,0,0,KA01*`;

let server;
let port;
beforeAll(async () => {
  server = startTcpServer(null, 0);
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  port = server.address().port;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

// Sends one packet and waits for the alert to be written.
const send = async (packet) => {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(packet);
  for (let i = 0; i < 100 && prisma.emergencyAlert.create.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  socket.destroy();
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.emergencyAlert.create.mockImplementation(async ({ data }) => ({ id: 'alert-1', ...data }));
  prisma.studentRouteMapping.findMany.mockResolvedValue([]);
  prisma.gpsLog.create.mockResolvedValue({});
  prisma.bus.update.mockResolvedValue({});
});

const bus = (id, schoolId, trips) => ({
  id, deviceId: `IMEI-${id}`, schoolId, licensePlate: 'KA01', status: 'ONLINE', trips,
});

describe('hardware SOS school', () => {
  it("goes to the bus's own school", async () => {
    prisma.bus.findUnique.mockResolvedValue(bus('b1', 's1', [{ id: 't1', route: { schoolId: 's1' } }]));

    await send(sosPacket('IMEI-b1'));

    expect(prisma.emergencyAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ schoolId: 's1', tripId: 't1', type: 'HARDWARE_SOS' }),
    });
    // The dark-bus sweep reads this: a tracker reports even when parked.
    expect(require('../busPresence').lastFixOf('b1')).toMatchObject({ source: 'tracker' });
  });

  it("falls back to the running trip's school when the bus has none", async () => {
    prisma.bus.findUnique.mockResolvedValue(bus('b2', null, [{ id: 't2', route: { schoolId: 's2' } }]));

    await send(sosPacket('IMEI-b2'));

    expect(prisma.emergencyAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ schoolId: 's2', tripId: 't2' }),
    });
    expect(prisma.bus.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        trips: {
          where: { status: { in: ['ON_SCHEDULE', 'DELAYED'] } },
          select: { id: true, route: { select: { schoolId: true } } },
        },
      },
    }));
  });

  it("is still filed as 'unknown' when there is no school to find", async () => {
    prisma.bus.findUnique.mockResolvedValue(bus('b3', null, []));

    await send(sosPacket('IMEI-b3'));

    expect(prisma.emergencyAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ schoolId: 'unknown', tripId: null }),
    });
  });
});

describe('hardware SOS delivery', () => {
  it("reaches the trip school's admins, not only super-admins", async () => {
    const io = makeIo();
    const live = startTcpServer(io, 0);
    await new Promise((resolve) => (live.listening ? resolve() : live.once('listening', resolve)));
    try {
      prisma.bus.findUnique.mockResolvedValue(bus('b4', null, [{ id: 't4', route: { schoolId: 's4' } }]));
      const socket = net.connect(live.address().port, '127.0.0.1');
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write(sosPacket('IMEI-b4'));
      for (let i = 0; i < 100 && !io.emits.some((e) => e.event === 'emergency_alert'); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      socket.destroy();

      const alertEmit = io.emits.find((e) => e.event === 'emergency_alert');
      expect(alertEmit.rooms).toEqual(['school-admin:s4', 'super:all']);
    } finally {
      await new Promise((resolve) => live.close(resolve));
    }
  });
});
