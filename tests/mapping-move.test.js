const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    student: { findUnique: jest.fn() },
    routeStop: { findUnique: jest.fn() },
    studentRouteMapping: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const NEW_STOP = '55555555-5555-4555-8555-555555555555';
const admin = () => jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);

beforeEach(() => jest.resetAllMocks());

const put = (body, id = 'm1') =>
  request(app).put(`/api/student-route-mappings/${id}`).set('Authorization', `Bearer ${admin()}`).send(body);

const existing = (over = {}) => ({ id: 'm1', studentId: 's1', direction: null, ...over });

const targetsResolve = (routeId = 'route-2') => {
  prisma.student.findUnique.mockResolvedValue({ schoolId: SCHOOL });
  prisma.routeStop.findUnique.mockResolvedValue({ routeId, route: { schoolId: SCHOOL } });
};

// Delete-then-create left the child assigned to nothing if the create failed. One UPDATE
// keeps the row and its id, so there is no window to reconcile.
describe('PUT /api/student-route-mappings/:id moves an assignment', () => {
  it('moves the stop in place, keeping the mapping id', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(existing());
    targetsResolve();
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
    prisma.studentRouteMapping.update.mockResolvedValue({ id: 'm1', routeStopId: NEW_STOP });

    const res = await put({ routeStopId: NEW_STOP });

    expect(res.status).toBe(200);
    expect(prisma.studentRouteMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm1' },
        data: { routeStopId: NEW_STOP, direction: null },
      })
    );
  });

  // Absent direction must not silently widen a leg-specific mapping back to both legs.
  it('keeps the leg the mapping already served when direction is omitted', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(existing({ direction: 'FROM_SCHOOL' }));
    targetsResolve();
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
    prisma.studentRouteMapping.update.mockResolvedValue({ id: 'm1' });

    await put({ routeStopId: NEW_STOP });

    expect(prisma.studentRouteMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { routeStopId: NEW_STOP, direction: 'FROM_SCHOOL' } })
    );
  });

  it('widens it to both legs only when null is sent explicitly', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(existing({ direction: 'FROM_SCHOOL' }));
    targetsResolve();
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
    prisma.studentRouteMapping.update.mockResolvedValue({ id: 'm1' });

    await put({ routeStopId: NEW_STOP, direction: null });

    expect(prisma.studentRouteMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { routeStopId: NEW_STOP, direction: null } })
    );
  });

  // Same rule as create, and it must not count the row being moved as its own conflict.
  it('excludes itself from the conflict search', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(existing());
    targetsResolve();
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
    prisma.studentRouteMapping.update.mockResolvedValue({ id: 'm1' });

    await put({ routeStopId: NEW_STOP });

    expect(prisma.studentRouteMapping.findFirst.mock.calls[0][0].where).toMatchObject({
      studentId: 's1',
      routeStop: { routeId: 'route-2' },
      id: { not: 'm1' },
    });
  });

  it('refuses a move onto a leg the child already has on that route', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(existing({ direction: 'TO_SCHOOL' }));
    targetsResolve();
    prisma.studentRouteMapping.findFirst.mockResolvedValue({
      direction: 'TO_SCHOOL',
      routeStop: { id: 'other', name: 'Maple Ave' },
    });

    const res = await put({ routeStopId: NEW_STOP });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Student already has a pickup stop on this route');
    expect(res.body.conflictingDirection).toBe('TO_SCHOOL');
    expect(prisma.studentRouteMapping.update).not.toHaveBeenCalled();
  });

  // Two rows naming different legs do not collide on the rule, so only the unique index
  // catches this — it must not surface as a 500.
  it('translates the unique violation into a conflict', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(existing({ direction: 'TO_SCHOOL' }));
    targetsResolve();
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
    prisma.studentRouteMapping.update.mockRejectedValue({ code: 'P2002' });

    const res = await put({ routeStopId: NEW_STOP });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MAPPING_EXISTS');
  });

  it('404s on a mapping that does not exist', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(null);
    expect((await put({ routeStopId: NEW_STOP })).status).toBe(404);
  });

  // Tenancy is checked against the mapping's own student, never a body field.
  it('refuses a stop in another school', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(existing());
    prisma.student.findUnique.mockResolvedValue({ schoolId: SCHOOL });
    prisma.routeStop.findUnique.mockResolvedValue({ routeId: 'r9', route: { schoolId: 'other-school' } });

    const res = await put({ routeStopId: NEW_STOP });

    expect(res.status).toBe(403);
    expect(prisma.studentRouteMapping.update).not.toHaveBeenCalled();
  });

  // studentId is not in the schema, so zod strips it. The point is that it is ignored
  // rather than honoured: a body field must never be able to move one child's stop onto
  // another child, and tenancy must be checked against the mapping's own student.
  it('ignores a studentId in the body instead of honouring it', async () => {
    prisma.studentRouteMapping.findUnique.mockResolvedValue(existing({ studentId: 's1' }));
    targetsResolve();
    prisma.studentRouteMapping.findFirst.mockResolvedValue(null);
    prisma.studentRouteMapping.update.mockResolvedValue({ id: 'm1' });

    const res = await put({ routeStopId: NEW_STOP, studentId: 's2' });

    expect(res.status).toBe(200);
    // Tenancy resolved through the mapping's student, not the body's.
    expect(prisma.student.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's1' } })
    );
    expect(prisma.studentRouteMapping.findFirst.mock.calls[0][0].where).toMatchObject({
      studentId: 's1',
    });
    expect(prisma.studentRouteMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm1' } })
    );
  });
});
