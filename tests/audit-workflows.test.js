const { createLeave, changeLeave } = require('../leaveWorkflows');

const NOW = new Date('2026-09-18T18:45:00.000Z'); // September 19 in the school timezone.
const PARENT = { id: 'parent-1', role: 'PARENT', schoolId: 'school-1' };
const ADMIN = { id: 'admin-1', role: 'SCHOOL_ADMIN', schoolId: 'school-1' };
const STUDENT = {
  id: 'student-1', parentId: 'parent-1', schoolId: 'school-1',
  school: { id: 'school-1', timezone: 'Asia/Kolkata' },
};
const body = (overrides = {}) => ({
  studentId: STUDENT.id, startDate: '2026-09-20', endDate: '2026-09-21',
  reason: 'Family appointment', scope: 'TRANSPORT', direction: 'TO_SCHOOL',
  ...overrides,
});

// This fake implements database predicates, not leave business rules. The production
// module must decide authorization, overlap, transitions and idempotency itself.
function matches(row, where = {}) {
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'OR') return condition.some((part) => matches(row, part));
    if (field === 'AND') return (Array.isArray(condition) ? condition : [condition]).every((part) => matches(row, part));
    if (field === 'NOT') return !matches(row, condition);
    const value = row[field];
    if (condition === null || typeof condition !== 'object' || condition instanceof Date) {
      return value instanceof Date && condition instanceof Date ? +value === +condition : value === condition;
    }
    return Object.entries(condition).every(([op, target]) => {
      if (op === 'in') return target.includes(value);
      if (op === 'not') return value !== target;
      if (op === 'lte') return value <= target;
      if (op === 'gte') return value >= target;
      if (op === 'lt') return value < target;
      if (op === 'gt') return value > target;
      if (op === 'equals') return value === target;
      // Prisma compound unique inputs wrap multiple row fields.
      return matches(row, { [op]: target });
    });
  });
}

function database(initial = []) {
  const rows = initial.map((row) => ({ ...row, student: STUDENT }));
  const db = {
    $queryRaw: jest.fn(async () => [{ id: STUDENT.id }]),
    student: { findUnique: jest.fn(async ({ where }) => where.id === STUDENT.id ? STUDENT : null) },
    school: { findUnique: jest.fn(async () => STUDENT.school) },
    trip: { findFirst: jest.fn(async () => null) },
    leaveApplication: {
      findUnique: jest.fn(async ({ where }) => rows.find((row) => matches(row, where)) || null),
      findFirst: jest.fn(async ({ where }) => rows.find((row) => matches(row, where)) || null),
      findMany: jest.fn(async ({ where } = {}) => rows.filter((row) => matches(row, where))),
      create: jest.fn(async ({ data }) => {
        const row = { id: `leave-${rows.length + 1}`, status: 'PENDING', createdAt: NOW, ...data, student: STUDENT };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const index = rows.findIndex((row) => matches(row, where));
        if (index < 0) throw new Error('Missing fake database row');
        rows[index] = { ...rows[index], ...data };
        return rows[index];
      }),
    },
  };
  db.$transaction = jest.fn(async (callback) => callback(db));
  return { db, rows };
}
const existing = (overrides = {}) => ({
  id: 'leave-existing', studentId: STUDENT.id, status: 'PENDING',
  startDate: new Date('2026-09-19T18:30:00.000Z'), endDate: new Date('2026-09-21T18:29:59.999Z'),
  startDay: '2026-09-20', endDay: '2026-09-21', timezone: 'Asia/Kolkata', history: [],
  reason: 'Existing appointment', scope: 'TRANSPORT', direction: 'TO_SCHOOL', ...overrides,
});

describe('leave creation guards', () => {
  it.each([
    ['invalid calendar date', { startDate: '2026-02-30' }],
    ['reversed range', { startDate: '2026-09-22', endDate: '2026-09-20' }],
    ['past school date despite the UTC date still being September 18', { startDate: '2026-09-18' }],
  ])('rejects %s before inserting', async (_name, overrides) => {
    const { db, rows } = database();
    await expect(createLeave(db, PARENT, body(overrides), null, NOW)).rejects.toMatchObject({ status: 400 });
    expect(rows).toHaveLength(0);
  });

  it('accepts legacy datetime input and interprets it in the school timezone', async () => {
    const { db } = database();
    const row = await createLeave(db, PARENT, body({
      startDate: '2026-09-18T18:30:00.000Z', endDate: '2026-09-19T18:29:59.000Z',
    }), null, NOW);
    expect(row.status).toBe('PENDING');
    expect(row.startDay).toBe('2026-09-19');
    expect(row.endDay).toBe('2026-09-19');
  });

  it('returns the original leave on a retry with the same key and same payload', async () => {
    const { db, rows } = database();
    const first = await createLeave(db, PARENT, body(), 'request-key-1', NOW);
    const retry = await createLeave(db, PARENT, body(), 'request-key-1', NOW);
    expect(retry.id).toBe(first.id);
    expect(rows).toHaveLength(1);
  });

  it('rejects reuse of the same key with a changed payload', async () => {
    const { db, rows } = database();
    await createLeave(db, PARENT, body(), 'request-key-1', NOW);
    await expect(createLeave(db, PARENT, body({ reason: 'Changed request' }), 'request-key-1', NOW))
      .rejects.toMatchObject({ status: 409 });
    expect(rows).toHaveLength(1);
  });

  it.each(['PENDING', 'APPROVED'])('rejects overlap with a %s leave for the same leg', async (status) => {
    const { db, rows } = database([existing({ status })]);
    await expect(createLeave(db, PARENT, body(), null, NOW)).rejects.toMatchObject({ status: 409 });
    expect(rows).toHaveLength(1);
  });

  it('allows overlapping calendar dates for disjoint transport legs', async () => {
    const { db, rows } = database([existing()]);
    const row = await createLeave(db, PARENT, body({ direction: 'FROM_SCHOOL' }), null, NOW);
    expect(row.direction).toBe('FROM_SCHOOL');
    expect(rows).toHaveLength(2);
  });

  it('rejects an all-leg request overlapping either transport leg', async () => {
    const { db } = database([existing()]);
    await expect(createLeave(db, PARENT, body({ direction: null }), null, NOW)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a parent creating leave for another parent’s child', async () => {
    const { db, rows } = database();
    await expect(createLeave(db, { ...PARENT, id: 'other-parent' }, body(), null, NOW))
      .rejects.toMatchObject({ status: 403 });
    expect(rows).toHaveLength(0);
  });

  it('enforces the school cutoff against the relevant scheduled journey', async () => {
    const { db } = database();
    STUDENT.school.leaveCutoffMinutes = 60;
    db.trip.findFirst.mockResolvedValue({ scheduledStart: new Date(+NOW + 30 * 60000) });
    try {
      await expect(createLeave(db, PARENT, body({ startDate: '2026-09-19', endDate: '2026-09-19' }), null, NOW))
        .rejects.toMatchObject({ status: 409 });
    } finally {
      delete STUDENT.school.leaveCutoffMinutes;
    }
  });
});

describe('leave transition guards', () => {
  it('allows a parent to edit their pending leave', async () => {
    const { db } = database([existing()]);
    const result = await changeLeave(db, PARENT, 'leave-existing', 'EDIT', { reason: 'Corrected reason' }, NOW);
    expect(result.reason).toBe('Corrected reason');
    expect(result.status).toBe('PENDING');
  });

  it('cancels a pending leave for its parent', async () => {
    const { db } = database([existing()]);
    expect((await changeLeave(db, PARENT, 'leave-existing', 'CANCEL', {}, NOW)).status).toBe('CANCELLED');
  });

  it('keeps an approved leave approved until the school confirms its cancellation', async () => {
    const { db } = database([existing({ status: 'APPROVED' })]);
    const row = await changeLeave(db, PARENT, 'leave-existing', 'CANCEL', {}, NOW);
    expect(row.status).toBe('APPROVED');
    expect(row.cancellationRequestedAt).toBeTruthy();
  });

  it('allows the school admin to cancel an approved leave', async () => {
    const { db } = database([existing({ status: 'APPROVED' })]);
    expect((await changeLeave(db, ADMIN, 'leave-existing', 'CANCEL', {}, NOW)).status).toBe('CANCELLED');
  });

  it.each(['EDIT', 'CANCEL', 'APPROVE', 'REJECT'])('rejects %s from another parent', async (action) => {
    const { db, rows } = database([existing()]);
    await expect(changeLeave(db, { ...PARENT, id: 'other-parent' }, 'leave-existing', action, {}, NOW))
      .rejects.toMatchObject({ status: 403 });
    expect(rows[0].status).toBe('PENDING');
  });

  it('does not let a parent approve their own request', async () => {
    const { db } = database([existing()]);
    await expect(changeLeave(db, PARENT, 'leave-existing', 'APPROVE', {}, NOW)).rejects.toMatchObject({ status: 403 });
  });

  it('does not let an administrator of another school approve leave', async () => {
    const { db } = database([existing()]);
    await expect(changeLeave(db, { ...ADMIN, schoolId: 'school-2' }, 'leave-existing', 'APPROVE', {}, NOW))
      .rejects.toMatchObject({ status: 403 });
  });

  it.each(['APPROVE', 'REJECT'])('allows an admin to %s a pending leave', async (action) => {
    const { db } = database([existing()]);
    const row = await changeLeave(db, ADMIN, 'leave-existing', action, { reason: 'School decision' }, NOW);
    expect(row.status).toBe(action === 'APPROVE' ? 'APPROVED' : 'REJECTED');
  });

  it('cannot approve a rejected terminal request', async () => {
    const { db, rows } = database([existing({ status: 'REJECTED' })]);
    await expect(changeLeave(db, ADMIN, 'leave-existing', 'APPROVE', {}, NOW)).rejects.toMatchObject({ status: 409 });
    expect(rows[0].status).toBe('REJECTED');
  });

  it('approves legacy rows that have timestamps but no migrated date-only fields', async () => {
    const { db } = database([existing({ startDay: null, endDay: null, timezone: null, history: null })]);
    const row = await changeLeave(db, ADMIN, 'leave-existing', 'APPROVE', {}, NOW);
    expect(row.status).toBe('APPROVED');
  });

  it('rejects editing an approved leave without changing its approved dates', async () => {
    const { db, rows } = database([existing({ status: 'APPROVED' })]);
    await expect(changeLeave(db, PARENT, 'leave-existing', 'EDIT', { startDate: '2026-09-21' }, NOW))
      .rejects.toMatchObject({ status: 409 });
    expect(rows[0].startDay).toBe('2026-09-20');
  });

  it('does not allow an edit to overlap another active request', async () => {
    const { db, rows } = database([
      existing(),
      existing({ id: 'other-leave', startDay: '2026-09-23', endDay: '2026-09-23',
        startDate: new Date('2026-09-22T18:30:00.000Z'), endDate: new Date('2026-09-23T18:29:59.999Z') }),
    ]);
    await expect(changeLeave(db, PARENT, 'leave-existing', 'EDIT', { endDate: '2026-09-23' }, NOW))
      .rejects.toMatchObject({ status: 409 });
    expect(rows[0].endDay).toBe('2026-09-21');
  });

  it('preserves earlier audit history while recording the administrator decision', async () => {
    const original = { action: 'CREATED', actorId: PARENT.id, at: '2026-09-18T17:00:00.000Z' };
    const { db } = database([existing({ history: [original] })]);
    const row = await changeLeave(db, ADMIN, 'leave-existing', 'APPROVE', { reason: 'Confirmed by office' }, NOW);
    expect(row.history).toEqual([original, expect.objectContaining({ action: 'APPROVE', actorId: ADMIN.id })]);
    expect(row.decidedBy).toBe(ADMIN.id);
    expect(row.decisionReason).toBe('Confirmed by office');
  });
});
