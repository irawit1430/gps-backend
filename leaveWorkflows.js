const crypto = require('crypto');
const { calendarDate, dateValue, dayBounds, DEFAULT_ZONE } = require('./schoolTime');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function own(user, student) {
  if (!student) fail(404, 'Student not found');
  if (user.role === 'SUPER_ADMIN' || (user.role === 'SCHOOL_ADMIN' && user.schoolId === student.schoolId) || (user.role === 'PARENT' && user.id === student.parentId)) return;
  fail(403, 'Forbidden');
}
function normalize(body, zone) {
  const startDay = dateValue(body.startDate, zone), endDay = dateValue(body.endDate, zone);
  if (!startDay || !endDay || startDay > endDay) fail(400, 'Provide valid school dates in ascending order');
  const scope = body.scope || 'SCHOOL';
  const direction = body.direction || null;
  if (!['SCHOOL', 'TRANSPORT'].includes(scope) || (direction && !['TO_SCHOOL', 'FROM_SCHOOL'].includes(direction))) fail(400, 'Invalid leave scope or direction');
  if (scope === 'SCHOOL' && direction) fail(400, 'School absence applies to both legs');
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) fail(400, 'Reason is required');
  return { startDay, endDay, scope, direction, reason: body.reason.trim(), notes: body.notes || null };
}
function storedDates(value, zone) {
  return { ...value, timezone: zone, startDate: dayBounds(value.startDay, zone).start, endDate: new Date(+dayBounds(value.endDay, zone).end - 1) };
}
function existingValue(leave, zone) {
  const startDay = leave.startDay || dateValue(leave.startDate instanceof Date ? leave.startDate.toISOString() : leave.startDate, zone);
  const endDay = leave.endDay || dateValue(leave.endDate instanceof Date ? leave.endDate.toISOString() : leave.endDate, zone);
  if (!startDay || !endDay) fail(409, 'Stored leave dates are invalid; ask the school to correct this request');
  return {
    startDay, endDay, scope: leave.scope || 'SCHOOL', direction: leave.direction || null,
    reason: leave.reason || 'Legacy leave request', notes: leave.notes || null,
  };
}
async function overlapping(tx, studentId, value, zone, exclude) {
  const canonical = value.startDay && value.endDay ? value : existingValue(value, zone);
  const dates = storedDates(canonical, zone);
  const other = await tx.leaveApplication.findFirst({ where: {
    studentId, status: { in: ['PENDING', 'APPROVED'] }, ...(exclude ? { id: { not: exclude } } : {}),
    startDate: { lte: dates.endDate }, endDate: { gte: dates.startDate },
    ...(canonical.direction ? { OR: [{ direction: null }, { direction: canonical.direction }] } : {}),
  } });
  if (other) fail(409, 'An overlapping leave already exists for this journey');
}
// The student row is the shared lock for create/edit/decision. It serializes overlap
// checks across processes, including requests with different idempotency keys.
async function lockStudent(tx, studentId) {
  await tx.$queryRaw`SELECT "id" FROM "Student" WHERE "id" = ${studentId} FOR UPDATE`;
}
async function createLeave(prisma, user, body, key, now = new Date()) {
  if (key && (typeof key !== 'string' || key.length > 200)) fail(400, 'Invalid Idempotency-Key');
  return prisma.$transaction(async tx => {
    const student = await tx.student.findUnique({ where: { id: body.studentId }, include: { school: { select: { timezone: true, leaveCutoffMinutes: true } } } });
    own(user, student);
    await lockStudent(tx, student.id);
    const zone = student.school?.timezone || DEFAULT_ZONE;
    const value = normalize(body, zone);
    const requestHash = hash(JSON.stringify({ studentId: student.id, ...value }));
    const requestKey = key ? hash(`${user.id}:${key}`) : null;
    if (requestKey) {
      const prior = await tx.leaveApplication.findUnique({ where: { requestKey } });
      if (prior) {
        if (prior.requestHash !== requestHash) fail(409, 'Idempotency-Key was already used for a different request');
        return prior;
      }
    }
    if (value.startDay < calendarDate(now, zone)) fail(400, 'Leave cannot start before the current school date');
    if (student.school?.leaveCutoffMinutes != null && tx.trip?.findFirst) {
      const bounds = dayBounds(value.startDay, zone);
      const departure = await tx.trip.findFirst({
        where: {
          serviceDate: { gte: bounds.start, lt: bounds.end },
          status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] },
          ...(value.direction ? { direction: value.direction } : {}),
          route: { stops: { some: { studentMappings: { some: { studentId: student.id } } } } },
        },
        orderBy: { scheduledStart: 'asc' },
        select: { scheduledStart: true },
      });
      if (departure?.scheduledStart && +new Date(departure.scheduledStart) - +now <= student.school.leaveCutoffMinutes * 60000) {
        fail(409, `The ${student.school.leaveCutoffMinutes}-minute leave cutoff has passed`);
      }
    }
    await overlapping(tx, student.id, value, zone);
    return tx.leaveApplication.create({ data: {
      studentId: student.id, ...storedDates(value, zone), status: 'PENDING', requestKey, requestHash,
      history: [{ action: 'CREATED', actorId: user.id, at: now.toISOString() }],
    } });
  });
}
async function changeLeave(prisma, user, id, action, body = {}, now = new Date()) {
  return prisma.$transaction(async tx => {
    let leave = await tx.leaveApplication.findUnique({ where: { id }, include: { student: { include: { school: { select: { timezone: true } } } } } });
    if (!leave) fail(404, 'Leave not found');
    own(user, leave.student);
    await lockStudent(tx, leave.studentId);
    leave = await tx.leaveApplication.findUnique({ where: { id }, include: { student: { include: { school: { select: { timezone: true } } } } } });
    const admin = ['SUPER_ADMIN', 'SCHOOL_ADMIN'].includes(user.role);
    const zone = leave.timezone || leave.student.school?.timezone || DEFAULT_ZONE;
    let data;
    if (action === 'EDIT') {
      if (leave.status !== 'PENDING') fail(409, 'Only pending requests can be edited');
      const value = normalize({ ...leave, startDate: leave.startDay || leave.startDate.toISOString(), endDate: leave.endDay || leave.endDate.toISOString(), ...body }, zone);
      if (value.startDay < calendarDate(now, zone)) fail(400, 'Leave cannot start in the past');
      await overlapping(tx, leave.studentId, value, zone, id);
      data = storedDates(value, zone);
    } else if (action === 'CANCEL') {
      if (leave.status === 'CANCELLED') return leave;
      if (!['PENDING', 'APPROVED'].includes(leave.status)) fail(409, 'Leave is already closed');
      data = leave.status === 'APPROVED' && !admin
        ? { cancellationRequestedAt: now }
        : { status: 'CANCELLED', decidedBy: user.id, decidedAt: now, decisionReason: body.reason || null, cancellationRequestedAt: null };
    } else if (['APPROVE', 'REJECT'].includes(action)) {
      if (!admin) fail(403, 'Only school administrators can decide leave');
      if (leave.status !== 'PENDING') fail(409, 'Only pending requests can be decided');
      const legacy = existingValue(leave, zone);
      if (action === 'APPROVE') await overlapping(tx, leave.studentId, legacy, zone, id);
      data = { ...(!leave.startDay || !leave.endDay ? storedDates(legacy, zone) : {}), status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', decisionReason: body.reason || null, decidedBy: user.id, decidedAt: now };
    } else fail(400, 'Unknown leave action');
    data.history = [...(Array.isArray(leave.history) ? leave.history : []), { action: data.cancellationRequestedAt ? 'CANCELLATION_REQUESTED' : action, actorId: user.id, at: now.toISOString(), reason: body.reason || null }];
    return tx.leaveApplication.update({ where: { id }, data });
  });
}
module.exports = { createLeave, changeLeave, normalize, own, fail, existingValue };
