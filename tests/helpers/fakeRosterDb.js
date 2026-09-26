// Just enough of Prisma, in memory, for the roster import to run against: the reads
// planRoster makes and the writes applyRoster makes. Each call is recorded so a test
// can say "nothing was written".

function fakeRosterDb({ students = [], users = [], routes = [], mappings = [] } = {}) {
  const db = { students, users, routes, mappings, writes: [] };
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  const lower = (s) => String(s || '').toLowerCase();
  const stopById = (sid) => {
    for (const r of db.routes) {
      const s = r.stops.find((x) => x.id === sid);
      if (s) return { ...s, routeId: r.id, route: { name: r.name } };
    }
    return null;
  };

  db.student = {
    findMany: jest.fn(async ({ where }) => {
      let list = db.students;
      if (where.rfidTag?.in) list = list.filter((s) => where.rfidTag.in.includes(s.rfidTag));
      if (where.schoolId) list = list.filter((s) => s.schoolId === where.schoolId);
      if (where.qrToken?.in) list = list.filter((s) => where.qrToken.in.includes(s.qrToken));
      return list.map((s) => ({
        ...s,
        parent: s.parentId ? { email: db.users.find((u) => u.id === s.parentId)?.email } : null,
        routeMappings: db.mappings.filter((m) => m.studentId === s.id).map((m) => ({ routeStopId: m.routeStopId, routeStop: stopById(m.routeStopId) })),
      }));
    }),
    create: jest.fn(async ({ data }) => {
      if (db.students.some((s) => s.rfidTag === data.rfidTag)) throw Object.assign(new Error('dup'), { code: 'P2002', meta: { target: ['rfidTag'] } });
      const row = { id: id('st'), ...data };
      db.students.push(row); db.writes.push(['student.create', row]);
      return { id: row.id };
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = db.students.find((s) => s.id === where.id);
      Object.assign(row, data); db.writes.push(['student.update', where.id, data]);
      return row;
    }),
  };
  db.user = {
    findMany: jest.fn(async ({ where }) => {
      const wanted = (where.OR || []).map((o) => lower(o.email.equals));
      return db.users.filter((u) => wanted.includes(lower(u.email)));
    }),
    create: jest.fn(async ({ data }) => {
      const row = { id: id('u'), ...data };
      db.users.push(row); db.writes.push(['user.create', row]);
      return { id: row.id };
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = db.users.find((u) => u.id === where.id);
      Object.assign(row, data); db.writes.push(['user.update', where.id, data]);
      return row;
    }),
  };
  db.route = {
    findMany: jest.fn(async ({ where }) => db.routes.filter((r) => r.schoolId === where.schoolId)),
  };
  db.studentRouteMapping = {
    create: jest.fn(async ({ data }) => {
      const row = { id: id('m'), ...data };
      db.mappings.push(row); db.writes.push(['mapping.create', row]);
      return row;
    }),
  };
  return db;
}

module.exports = { fakeRosterDb };
