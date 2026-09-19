const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('./middleware/validate');
const S = require('./schemas');
const { createLeave, changeLeave, fail } = require('./leaveWorkflows');
const { calendarDate, DEFAULT_ZONE } = require('./schoolTime');
const uuid = z.string().uuid();
const text = z.string().trim().min(1).max(1000);
const limitOf = req => Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
const guarded = fn => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    req.log?.error({ err }, 'parent workflow failed');
    res.status(err.status || (err.code === 'P2002' ? 409 : 500)).json({ error: err.status ? err.message : err.code === 'P2002' ? 'Conflicting request; refresh and retry' : 'Internal server error' });
  }
};
function registerAuditRoutes(app, { prisma, io, emitToUser, emitToSchool, isPushConfigured, pushToUsers, parentIdsOnTrip, mailer }) {
  const router = Router();
  const emit = (id, event, payload) => emitToUser(io, id, event, payload);
  async function parentAccess(req) {
    if (req.user.id === req.params.parentId && req.user.role === 'PARENT') return;
    if (req.user.role === 'SUPER_ADMIN') return;
    const target = await prisma.user.findUnique({ where: { id: req.params.parentId }, select: { schoolId: true, role: true } });
    if (req.user.role !== 'SCHOOL_ADMIN' || target?.role !== 'PARENT' || target.schoolId !== req.user.schoolId) fail(403, 'Forbidden');
  }
  async function incidentAccess(user, id) {
    const alert = await prisma.emergencyAlert.findUnique({ where: { id } });
    if (!alert) fail(404, 'Incident not found');
    if (user.role === 'SUPER_ADMIN' || (user.role === 'SCHOOL_ADMIN' && user.schoolId === alert.schoolId) || (user.role === 'DRIVER' && user.id === alert.senderId)) return alert;
    // Older alerts predate the explicit audience field. Do not widen those records to
    // every parent merely because they share a school; only an explicit parent
    // audience is readable by a parent.
    if (user.role !== 'PARENT' || !['ALL', 'PARENTS'].includes(alert.audience)) fail(403, 'Forbidden');
    const child = await prisma.student.findFirst({ where: { parentId: user.id, schoolId: alert.schoolId,
      ...(alert.tripId ? { routeMappings: { some: { routeStop: { route: { trips: { some: { id: alert.tripId } } } } } } } : {}),
    }, select: { id: true } });
    if (!child) fail(403, 'Forbidden');
    return alert;
  }
  async function notifyLeave(row) {
    const student = await prisma.student.findUnique({ where: { id: row.studentId }, select: { parentId: true, schoolId: true } });
    if (!student) return;
    const context = { type: 'LEAVE', studentId: row.studentId, leaveId: row.id };
    if (student.parentId) {
      emit(student.parentId, 'leave_changed', { ...context, status: row.status, updatedAt: row.updatedAt });
      const n = await prisma.notification.create({ data: { userId: student.parentId, title: 'Leave request updated', message: row.cancellationRequestedAt ? 'Cancellation requested; approved absence remains effective until the school confirms.' : `Leave status: ${row.status}.`, type: 'LEAVE', context } });
      emit(student.parentId, 'notification', n);
      await pushToUsers([student.parentId], { title: n.title, body: n.message, data: { ...context, notificationId: n.id } });
    }
    emitToSchool(io, student.schoolId, 'leave_changed', { ...context, status: row.status });
    const trips = await prisma.trip.findMany({ where: { route: { stops: { some: { studentMappings: { some: { studentId: row.studentId } } } } }, status: { in: ['PLANNED', 'ON_SCHEDULE', 'DELAYED'] } }, select: { driverId: true } });
    for (const id of new Set(trips.map(t => t.driverId))) emit(id, 'leave_changed', context);
  }
  const afterLeave = row => notifyLeave(row).catch(err => console.error('Leave notification failed', err.message));
  router.post('/api/leaves', validate({ body: S.leaveApp }), guarded(async (req, res) => {
    const row = await createLeave(prisma, req.user, req.body, req.get('Idempotency-Key'));
    res.json(row);
    emitToSchool(io, req.user.schoolId, 'leave_changed', { leaveId: row.id, studentId: row.studentId });
  }));
  const decision = z.object({ reason: text.optional() }).default({});
  for (const [suffix, action] of [['approve', 'APPROVE'], ['reject', 'REJECT'], ['cancel', 'CANCEL']]) {
    router.put(`/api/leaves/:id/${suffix}`, validate({ body: decision }), guarded(async (req, res) => {
      const row = await changeLeave(prisma, req.user, req.params.id, action, req.body);
      res.json(row); await afterLeave(row);
    }));
  }
  router.patch('/api/leaves/:id', validate({ body: S.leaveApp.omit({ studentId: true }).partial() }), guarded(async (req, res) => {
    const row = await changeLeave(prisma, req.user, req.params.id, 'EDIT', req.body);
    res.json(row); await afterLeave(row);
  }));
  router.delete('/api/leaves/:id', guarded(async (req, res) => {
    const row = await changeLeave(prisma, req.user, req.params.id, 'CANCEL', {});
    // Preserve the legacy successful pending-withdrawal response. Approved leave
    // returns its still-effective state so clients cannot mistake a request for cancellation.
    if (row.status === 'CANCELLED') res.status(204).end(); else res.status(202).json(row);
    await afterLeave(row);
  }));
  router.put('/api/parent/leaves/:id', validate({ body: S.leaveStatus }), guarded(async (req, res) => {
    const row = await changeLeave(prisma, req.user, req.params.id, req.body.status === 'APPROVED' ? 'APPROVE' : 'REJECT', req.body);
    res.json(row); await afterLeave(row);
  }));
  router.patch('/api/parents/:id/preferences', validate({ body: S.preferences }), guarded(async (req, res) => {
    if (req.user.id !== req.params.id && req.user.role !== 'SUPER_ADMIN') fail(403, 'Forbidden');
    const preferences = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${req.params.id} FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: req.params.id } });
      if (!user) fail(404, 'User not found');
      let old = user.notificationSettings || {};
      if (typeof old === 'string') { try { old = JSON.parse(old); } catch { old = {}; } }
      const merged = { ...old, ...req.body };
      await tx.user.update({ where: { id: user.id }, data: { notificationSettings: merged } });
      return merged;
    });
    res.json({ preferences });
  }));

  const deviceSchema = z.object({ deviceId: z.string().min(1).max(200), platform: z.enum(['ANDROID', 'IOS']), provider: z.literal('FCM'), token: z.string().min(10).max(4096) });
  router.post('/api/users/me/push-devices', validate({ body: deviceSchema }), guarded(async (req, res) => {
    if (!isPushConfigured()) return res.status(503).json({ pushEnabled: false, error: 'Push notifications are not configured' });
    const { deviceId, token, platform, provider } = req.body;
    const record = await prisma.$transaction(async tx => {
      // A rotating/reassigned installation token belongs to exactly one account.
      await tx.pushDevice.deleteMany({ where: { token, NOT: { userId: req.user.id, deviceId } } });
      return tx.pushDevice.upsert({ where: { userId_deviceId: { userId: req.user.id, deviceId } }, create: { userId: req.user.id, ...req.body }, update: { token, platform, provider, enabled: true, lastFailure: null, lastAcceptedAt: null } });
    });
    res.json({ id: record.id, registered: true, deliveryConfirmed: false, provider });
  }));
  router.delete('/api/users/me/push-devices/:deviceId', guarded(async (req, res) => {
    await prisma.pushDevice.deleteMany({ where: { userId: req.user.id, deviceId: req.params.deviceId } });
    res.status(204).end();
  }));
  router.get('/api/users/me/notification-readiness', guarded(async (req, res) => {
    const [devices, user] = await Promise.all([
      prisma.pushDevice.findMany({ where: { userId: req.user.id }, select: { deviceId: true, platform: true, provider: true, enabled: true, lastAcceptedAt: true, lastFailure: true } }),
      prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true, fcmToken: true, notificationSettings: true } }),
    ]);
    let preferences = user?.notificationSettings || {};
    if (typeof preferences === 'string') { try { preferences = JSON.parse(preferences); } catch { preferences = {}; } }
    res.json({ pushConfigured: isPushConfigured(), supportedProviders: ['FCM'], devices, legacyTokenRegistered: Boolean(user?.fcmToken), deliveryConfirmed: devices.some(d => Boolean(d.lastAcceptedAt)),
      email: { configured: mailer.isConfigured(), recipient: user?.email || null }, sms: { configured: false }, permissionSource: 'DEVICE', preferences });
  }));

  const stopEventSchema = z.object({
    type: z.enum(['ARRIVED', 'DEPARTED', 'SKIPPED']),
    occurredAt: z.string().datetime().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  }).refine(v => (v.lat == null) === (v.lng == null), { message: 'lat and lng must be supplied together' });
  router.post('/api/trips/:tripId/stops/:stopId/events', validate({ body: stopEventSchema }), guarded(async (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 200) fail(400, 'Idempotency-Key is required');
    const trip = await prisma.trip.findUnique({ where: { id: req.params.tripId }, include: { route: { select: { schoolId: true } } } });
    if (!trip) fail(404, 'Trip not found');
    const allowed = req.user.role === 'SUPER_ADMIN' ||
      (req.user.role === 'SCHOOL_ADMIN' && req.user.schoolId === trip.route.schoolId) ||
      (req.user.role === 'DRIVER' && req.user.id === trip.driverId);
    if (!allowed) fail(403, 'Forbidden');
    const stop = await prisma.routeStop.findFirst({ where: { id: req.params.stopId, routeId: trip.routeId }, select: { id: true } });
    if (!stop) fail(404, 'Stop not found on this trip');
    const requestKey = require('crypto').createHash('sha256').update(`${req.user.id}:${key}`).digest('hex');
    const prior = await prisma.stopEvent.findUnique({ where: { requestKey } });
    if (prior) return res.json({ ...prior, duplicate: true });
    const occurredAt = req.body.occurredAt ? new Date(req.body.occurredAt) : new Date();
    if (+occurredAt > Date.now() + 60000) fail(400, 'Event time is in the future');
    const event = await prisma.stopEvent.create({ data: { tripId: trip.id, stopId: stop.id, type: req.body.type, occurredAt, recordedBy: req.user.id, lat: req.body.lat ?? null, lng: req.body.lng ?? null, requestKey } });
    const payload = { tripId: trip.id, stopId: stop.id, type: event.type, occurredAt: event.occurredAt };
    emitToSchool(io, trip.route.schoolId, 'journey_changed', payload);
    const parents = await parentIdsOnTrip(trip.id);
    parents.forEach(id => emit(id, 'journey_changed', payload));
    res.status(201).json(event);
  }));

  router.get('/api/parents/:parentId/alerts', guarded(async (req, res) => {
    await parentAccess(req);
    const children = await prisma.student.findMany({ where: { parentId: req.params.parentId }, select: { id: true, schoolId: true, routeMappings: { select: { direction: true, routeStop: { select: { routeId: true } } } } } });
    const routeIds = [...new Set(children.flatMap(c => c.routeMappings.map(m => m.routeStop.routeId)))];
    const trips = await prisma.trip.findMany({ where: { routeId: { in: routeIds } }, select: { id: true, routeId: true, direction: true } });
    const alerts = await prisma.emergencyAlert.findMany({ where: { audience: { not: 'DRIVERS' }, OR: [{ tripId: { in: trips.map(t => t.id) } }, { tripId: null, schoolId: { in: [...new Set(children.map(c => c.schoolId))] } }], ...(req.query.status === 'ACTIVE' ? { status: 'ACTIVE' } : {}) }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }], take: limitOf(req) });
    const acknowledgements = await prisma.incidentAcknowledgement.findMany({ where: { userId: req.params.parentId, alertId: { in: alerts.map(a => a.id) } } });
    res.json(alerts.map(a => {
      const t = trips.find(t => t.id === a.tripId);
      const ack = acknowledgements.find(x => x.alertId === a.id);
      return { ...a, resolved: a.status === 'RESOLVED', acknowledged: Boolean(ack && +ack.alertUpdatedAt >= +a.updatedAt), acknowledgedAt: ack?.acknowledgedAt || null,
        studentIds: children.filter(c => c.schoolId === a.schoolId && (!t || c.routeMappings.some(m => m.routeStop.routeId === t.routeId && (!m.direction || !t.direction || m.direction === t.direction)))).map(c => c.id) };
    }).filter(a => a.studentIds.length));
  }));
  router.get('/api/alerts/:id', guarded(async (req, res) => res.json(await incidentAccess(req.user, req.params.id))));
  router.post('/api/alerts/:id/acknowledge', guarded(async (req, res) => {
    const a = await incidentAccess(req.user, req.params.id);
    const row = await prisma.incidentAcknowledgement.upsert({ where: { alertId_userId: { alertId: a.id, userId: req.user.id } }, create: { alertId: a.id, userId: req.user.id, alertUpdatedAt: a.updatedAt }, update: { acknowledgedAt: new Date(), alertUpdatedAt: a.updatedAt } });
    res.json({ ...row, status: a.status, resolved: a.status === 'RESOLVED' });
  }));
  router.patch('/api/alerts/:id', validate({ body: z.object({ message: text }) }), guarded(async (req, res) => {
    const a = await incidentAccess(req.user, req.params.id);
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN'].includes(req.user.role)) fail(403, 'Only administrators can update incidents');
    const updated = await prisma.emergencyAlert.update({ where: { id: a.id }, data: { message: req.body.message } });
    await broadcastIncident(updated); res.json(updated);
  }));
  async function broadcastIncident(alert) {
    emitToSchool(io, alert.schoolId, 'emergency_alert', alert);
    if (alert.senderId) emit(alert.senderId, 'emergency_alert', alert);
    const parents = await prisma.user.findMany({ where: { schoolId: alert.schoolId, role: 'PARENT', ...(alert.tripId ? { parentStudents: { some: { routeMappings: { some: { routeStop: { route: { trips: { some: { id: alert.tripId } } } } } } } } } : {}) }, select: { id: true } });
    if (alert.audience !== 'DRIVERS') for (const p of parents) emit(p.id, 'emergency_alert', alert);
  }
  router.post('/api/notifications/:id/resolve', validate({ body: z.object({ reason: text.optional() }).default({}) }), guarded(async (req, res) => {
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN'].includes(req.user.role)) fail(403, 'Forbidden');
    const a = await incidentAccess(req.user, req.params.id);
    const updated = a.status === 'RESOLVED' ? a : await prisma.emergencyAlert.update({ where: { id: a.id }, data: { status: 'RESOLVED', resolvedBy: req.user.id, resolvedAt: new Date(), resolutionNote: req.body.reason || null } });
    await broadcastIncident(updated); res.json({ success: true, id: a.id, status: updated.status, resolvedAt: updated.resolvedAt });
  }));
  router.get('/api/users/me/notifications/unread-count', guarded(async (req, res) => res.json({ unreadCount: await prisma.notification.count({ where: { userId: req.user.id, isRead: false } }) })));
  router.post('/api/notifications/mark-read', validate({ body: z.object({ ids: z.array(uuid).max(200).optional(), before: z.string().datetime().optional() }).default({}) }), guarded(async (req, res) => {
    const result = await prisma.notification.updateMany({ where: { userId: req.user.id, ...(req.body.ids ? { id: { in: req.body.ids } } : { createdAt: { lte: req.body.before ? new Date(req.body.before) : new Date() } }) }, data: { isRead: true } });
    res.json({ success: true, count: result.count });
  }));
  router.get('/api/parents/:parentId/students/:studentId/attendance', guarded(async (req, res) => {
    await parentAccess(req);
    const student = await prisma.student.findFirst({ where: { id: req.params.studentId, parentId: req.params.parentId }, select: { id: true, school: { select: { timezone: true } } } });
    if (!student) fail(404, 'Child not found');
    const cursor = req.query.cursor;
    if (cursor && !uuid.safeParse(cursor).success) fail(400, 'Invalid cursor');
    const rows = await prisma.attendanceLog.findMany({ where: { studentId: student.id }, orderBy: [{ timestamp: 'desc' }, { id: 'desc' }], take: limitOf(req) + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { trip: { select: { direction: true, serviceDate: true, routeId: true } } } });
    const more = rows.length > limitOf(req); const items = rows.slice(0, limitOf(req)).map(r => ({ ...r, createdAt: r.timestamp, schoolDate: calendarDate(r.timestamp, student.school?.timezone || DEFAULT_ZONE), stopName: r.stopName || null }));
    if (more) res.set('X-Next-Cursor', items[items.length - 1].id);
    // Existing apps expect an array. New clients may opt into the page envelope.
    res.json(req.query.page === '1' ? { items, nextCursor: more ? items[items.length - 1].id : null } : items);
  }));

  router.post('/api/users/me/requests', validate({ body: z.object({ type: z.enum(['CONTACT_CORRECTION', 'ACCOUNT_DATA', 'ACCOUNT_DELETION', 'CHILD_LINK', 'ATTENDANCE_DISCREPANCY']), message: text }) }), guarded(async (req, res) => {
    const row = await prisma.accountRequest.create({ data: { userId: req.user.id, schoolId: req.user.schoolId || null, ...req.body } });
    emitToSchool(io, req.user.schoolId, 'account_request', { id: row.id }); res.status(201).json(row);
  }));
  router.get('/api/users/me/requests', guarded(async (req, res) => res.json(await prisma.accountRequest.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100 }))));
  router.get('/api/schools/:schoolId/account-requests', guarded(async (req, res) => {
    if (req.user.role !== 'SUPER_ADMIN' && !(req.user.role === 'SCHOOL_ADMIN' && req.user.schoolId === req.params.schoolId)) fail(403, 'Forbidden');
    res.json(await prisma.accountRequest.findMany({ where: { schoolId: req.params.schoolId }, orderBy: { createdAt: 'desc' }, take: 100 }));
  }));
  router.patch('/api/account-requests/:id', validate({ body: z.object({ status: z.enum(['RESOLVED', 'REJECTED']), reason: text }) }), guarded(async (req, res) => {
    const row = await prisma.accountRequest.findUnique({ where: { id: req.params.id } });
    if (!row) fail(404, 'Request not found');
    if (req.user.role !== 'SUPER_ADMIN' && !(req.user.role === 'SCHOOL_ADMIN' && req.user.schoolId === row.schoolId)) fail(403, 'Forbidden');
    const updated = await prisma.accountRequest.update({ where: { id: row.id }, data: { status: req.body.status, decisionReason: req.body.reason } });
    emit(row.userId, 'account_request_changed', { id: row.id, status: updated.status }); res.json(updated);
  }));
  app.use(router);
}
module.exports = { registerAuditRoutes, guarded };
