const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    trip: { findUnique: jest.fn() },
    emergencyAlert: { create: jest.fn() },
    student: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

jest.mock('../firebase', () => ({
  sendPush: jest.fn().mockResolvedValue({ sent: 0, invalidTokens: [] }),
  isPushConfigured: jest.fn(() => false),
  syncGpsLogToFirebase: jest.fn(),
  syncEmergencyAlertToFirebase: jest.fn(),
  syncStudentToFirebase: jest.fn(),
  flushFirestore: jest.fn(),
  app: null,
  db: null,
  messaging: null,
}));

const { app, prisma } = require('../server');

const SCHOOL = '11111111-1111-4111-8111-111111111111';
const OTHER_SCHOOL = '22222222-2222-4222-8222-222222222222';
const TRIP = '33333333-3333-4333-8333-333333333333';
const STUDENT = '44444444-4444-4444-8444-444444444444';
const admin = jwt.sign({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, process.env.JWT_SECRET);

describe('tenant resource integrity', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a broadcast that references another school\'s trip before creating an alert', async () => {
    prisma.trip.findUnique.mockResolvedValue({
      id: TRIP,
      driverId: 'driver-2',
      route: { schoolId: OTHER_SCHOOL, stops: [] },
    });

    const res = await request(app)
      .post(`/api/schools/${SCHOOL}/broadcast`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ message: 'School notice', tripId: TRIP });

    expect(res.status).toBe(403);
    expect(prisma.emergencyAlert.create).not.toHaveBeenCalled();
  });

  it('rejects QR-card requests containing a student outside the authorized school', async () => {
    prisma.student.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/schools/${SCHOOL}/qr-cards`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ studentIds: [STUDENT] });

    expect(res.status).toBe(403);
    expect(prisma.student.updateMany).not.toHaveBeenCalled();
  });
});
