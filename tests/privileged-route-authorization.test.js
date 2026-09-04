const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    $transaction: jest.fn(),
    user: { findUnique: jest.fn() },
    emergencyAlert: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'alert-1',
        schoolId: '11111111-1111-4111-8111-111111111111',
        senderId: 'someone-else',
        status: 'ACTIVE',
      }),
      create: jest.fn().mockResolvedValue({
        id: 'alert-2',
        schoolId: '11111111-1111-4111-8111-111111111111',
        senderId: 'parent-1',
        status: 'ACTIVE',
      }),
    },
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

const { app } = require('../server');

const SCHOOL = '11111111-1111-4111-8111-111111111111';
const ROUTE = '22222222-2222-4222-8222-222222222222';
const SECRET = process.env.JWT_SECRET;
const parent = jwt.sign({ id: 'parent-1', role: 'PARENT', schoolId: SCHOOL }, SECRET);
const driver = jwt.sign({ id: 'driver-1', role: 'DRIVER', schoolId: SCHOOL }, SECRET);
const superAdmin = jwt.sign({ id: 'super-1', role: 'SUPER_ADMIN', schoolId: null }, SECRET);
const schoolAdmin = jwt.sign({ id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);

const get = (path, token = parent) =>
  request(app).get(path).set('Authorization', `Bearer ${token}`);

describe('privileged school routes reject non-admin accounts before database access', () => {
  test.each([
    `/api/schools/${SCHOOL}/buses`,
    `/api/schools/${SCHOOL}/leaves`,
    `/api/schools/${SCHOOL}/leaves/pending`,
    `/api/schools/${SCHOOL}/routes`,
    `/api/schools/${SCHOOL}/parents`,
    `/api/schools/${SCHOOL}/drivers`,
    `/api/schools/${SCHOOL}/students`,
    `/api/schools/${SCHOOL}/attendance/today`,
    `/api/schools/${SCHOOL}/stats`,
    `/api/schools/${SCHOOL}`,
    `/api/routes/${ROUTE}/runs`,
    `/api/routes/${ROUTE}/schedule-preview`,
    '/api/calendar',
  ])('returns 403 to a parent for %s', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(403);
  });

  it('returns 403 to a driver reading the school-wide student roster', async () => {
    const res = await get(`/api/schools/${SCHOOL}/students`, driver);
    expect(res.status).toBe(403);
  });
});

describe('emergency endpoints enforce role and resource authorization', () => {
  it('does not let a parent read another user\'s alert merely because it is in their school', async () => {
    const res = await get('/api/alerts/alert-1');
    expect(res.status).toBe(403);
  });

  it('does not let a parent raise a driver SOS', async () => {
    const res = await request(app)
      .post('/api/alerts/sos')
      .set('Authorization', `Bearer ${parent}`)
      .send({ message: 'test' });

    expect(res.status).toBe(403);
  });
});

describe('school admins cannot use role bypasses against another tenant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { prisma } = require('../server');
    prisma.user.findUnique.mockResolvedValue({ id: 'target', role: 'PARENT', schoolId: 'other-school' });
  });

  it('rejects another school parent\'s student list', async () => {
    const res = await get('/api/parents/parent-other/students', schoolAdmin);
    expect(res.status).toBe(403);
  });

  it('rejects another school driver\'s trip list', async () => {
    const { prisma } = require('../server');
    prisma.user.findUnique.mockResolvedValue({ id: 'driver-other', role: 'DRIVER', schoolId: 'other-school' });

    const res = await get('/api/drivers/driver-other/trips', schoolAdmin);
    expect(res.status).toBe(403);
  });
});

describe('bulk student import abuse limits', () => {
  it('rejects more than 500 rows before opening a transaction', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ name: `Student ${i}` }));
    const res = await request(app)
      .post(`/api/schools/${SCHOOL}/students/bulk`)
      .set('Authorization', `Bearer ${superAdmin}`)
      .send(rows);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });
});
