const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    bus: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');
const SECRET = process.env.JWT_SECRET;
const schoolAdmin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' }, SECRET);
const superAdmin = jwt.sign({ id: 's1', role: 'SUPER_ADMIN' }, SECRET);

const get = (who, qs = '') =>
  request(app).get(`/api/devices${qs}`).set('Authorization', `Bearer ${who}`);

const whereOf = () => prisma.bus.findMany.mock.calls[0][0].where;

describe('GET /api/devices — tenant scoping', () => {
  beforeEach(() => jest.clearAllMocks());

  it('scopes a school admin to their own school', async () => {
    await get(schoolAdmin);
    expect(whereOf().schoolId).toBe('school-1');
  });

  // `assigned=false` used to sit outside the role branch and overwrite the scoping
  // above it, handing any school admin every unassigned device on the platform with
  // its IMEI. The super-admin console's device picker is the caller, and it was
  // relying on a client-side filter to make that safe.
  it('does not let ?assigned=false widen a school admin past their own school', async () => {
    await get(schoolAdmin, '?assigned=false');
    expect(whereOf().schoolId).toBe('school-1');
  });

  it('does not let ?schoolId widen a school admin either', async () => {
    await get(schoolAdmin, '?schoolId=school-2');
    expect(whereOf().schoolId).toBe('school-1');
  });

  // Unassigned devices are platform inventory — that IS a super admin's question.
  it('still lets a super admin list unassigned devices', async () => {
    await get(superAdmin, '?assigned=false');
    expect(whereOf().schoolId).toBeNull();
  });

  it('lets a super admin filter by any school', async () => {
    await get(superAdmin, '?schoolId=school-9');
    expect(whereOf().schoolId).toBe('school-9');
  });
});
