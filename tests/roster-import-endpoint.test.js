// POST /api/schools/:schoolId/students/bulk: a dry run writes nothing and says what
// would happen; an import happens only if every row is clean, all at once.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { fakeRosterDb } = require('./helpers/fakeRosterDb');

let mockDb;
jest.mock('@prisma/client', () => {
  const route = (model, fn) => (...args) => mockDb[model][fn](...args);
  const mockPrisma = {
    student: { findMany: route('student', 'findMany') },
    user: { findMany: route('user', 'findMany') },
    route: { findMany: route('route', 'findMany') },
    $transaction: jest.fn(async (fn) => fn(mockDb)),
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);
const otherAdmin = jwt.sign({ id: 'a2', role: 'SCHOOL_ADMIN', schoolId: '22222222-2222-4222-8222-222222222222' }, SECRET);

beforeEach(() => {
  mockDb = fakeRosterDb({
    routes: [{ id: 'r1', schoolId: SCHOOL, name: 'Route 1', stops: [{ id: 'st-a', name: 'Gate' }] }],
  });
  prisma.$transaction.mockClear();
});

const post = (rows, query = '', token = admin) =>
  request(app).post(`/api/schools/${SCHOOL}/students/bulk${query}`).set('Authorization', `Bearer ${token}`).send(rows);

const clean = [
  { line: 2, rfidTag: 'A-1', name: 'Asha', parentEmail: 'sunita@mail.com', route: 'Route 1', stop: 'Gate' },
  { line: 3, rfidTag: 'A-2', name: 'Arun' },
];

describe('dry run', () => {
  it('answers with every row and writes nothing', async () => {
    const res = await post(clean, '?dryRun=1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, committed: false, totals: { rows: 2, new: 2, ready: 1, noParent: 1 } });
    expect(res.body.rows.map((r) => [r.line, r.state])).toEqual([[2, 'INVITE_READY'], [3, 'NO_PARENT']]);
    expect(res.body.rows[0]).not.toHaveProperty('_');
    expect(mockDb.writes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('import', () => {
  it('writes every clean row in one transaction', async () => {
    const res = await post(clean);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, committed: true, message: 'Imported 2 new students and updated 0.' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.students).toHaveLength(2);
    expect(mockDb.mappings).toHaveLength(1);
  });

  it('writes nothing if one row needs correcting, and says which', async () => {
    const res = await post([...clean, { line: 4, rfidTag: 'A-3', name: 'Anu', route: 'Route 9', stop: 'Gate' }]);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('1 row needs correcting. Nothing was imported.');
    expect(res.body.rows.find((r) => r.line === 4).errors[0]).toMatch(/No route called "Route 9"/);
    expect(mockDb.writes).toEqual([]);
  });

  it('turns a race on a Student ID into a 409, not a 500', async () => {
    mockDb.student.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002', meta: { target: ['rfidTag'] } }));
    const res = await post(clean);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^Import aborted:/);
  });

  it('refuses rows without a Student ID before touching anything', async () => {
    const res = await post([{ name: 'No ID' }]);
    expect(res.status).toBe(400);
    expect(res.body.issues[0]).toMatchObject({ path: '0.rfidTag' });
  });

  it('only for the admin\'s own school', async () => {
    const res = await post(clean, '', otherAdmin);
    expect(res.status).toBe(403);
    expect(mockDb.writes).toEqual([]);
  });

  it('accepts a 1,200-child file, bigger than the usual request limit', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => ({ line: i + 2, rfidTag: `R-${String(i).padStart(4, '0')}`, name: `Student number ${i}`, grade: 'Class 5 Section B', guardianPhone: '+91 98765 43210', parentEmail: `family.number.${i}@example-school.in`, parentName: `Guardian of student number ${i}`, route: 'Route 1', stop: 'Gate' }));
    expect(Buffer.byteLength(JSON.stringify(many))).toBeGreaterThan(256 * 1024);

    const res = await post(many, '?dryRun=1');
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ rows: 1200, new: 1200, parentsCreated: 1200, stopsAssigned: 1200, ready: 1200 });
  });
});
