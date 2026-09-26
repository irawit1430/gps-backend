// The whole roster in one file: child, Student ID, class, parent email, route and stop.
// What an import would do is decided once (planRoster); nothing is written unless every
// row is clean; and running the same file twice changes nothing.

const S = require('../schemas');
const { planRoster, applyRoster, totals, publicPlan } = require('../rosterImport');
const { fakeRosterDb } = require('./helpers/fakeRosterDb');

const SCHOOL = 'school-1';
const OTHER = 'school-2';

const routes = () => [
  { id: 'r1', schoolId: SCHOOL, name: 'Route 1 Kankarbagh', stops: [{ id: 'st-a', name: 'Rajendra Nagar' }, { id: 'st-b', name: 'Patliputra Gate' }] },
  { id: 'r2', schoolId: SCHOOL, name: 'Route 2', stops: [{ id: 'st-c', name: 'Boring Road' }] },
  { id: 'r9', schoolId: OTHER, name: 'Route 1 Kankarbagh', stops: [{ id: 'st-z', name: 'Elsewhere' }] },
];

const rows = (list) => S.bulkStudents.parse(list);
const qrFieldsFor = (t) => (t ? { qrToken: t, qrCodeImported: true, qrCardPrintedAt: new Date() } : { qrToken: 'gen', qrCodeImported: false, qrCardPrintedAt: null });

async function importInto(db, list) {
  const planned = await planRoster(db, SCHOOL, rows(list));
  if (planned.some((p) => p.errors.length)) return { planned, written: 0 };
  const written = await applyRoster(db, SCHOOL, planned, { lockedHash: 'LOCKED', qrFieldsFor });
  return { planned, written };
}

describe('the row format', () => {
  it('needs a Student ID on every row, because that is what makes a rerun safe', () => {
    expect(() => rows([{ name: 'Asha' }])).toThrow();
  });

  it('reads empty cells as not given and lowercases the parent email', () => {
    const [r] = rows([{ rfidTag: ' R1 ', name: ' Asha ', grade: '', parentEmail: ' Asha.P@Mail.COM ', route: '', stop: '' }]);
    expect(r).toMatchObject({ rfidTag: 'R1', name: 'Asha', grade: null, parentEmail: 'asha.p@mail.com', route: null, stop: null });
  });

  it('takes a whole 1,200-child school in one file, and not unlimited', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ rfidTag: `R${i}`, name: `S${i}` }));
    expect(() => S.bulkStudents.parse(many(1200))).not.toThrow();
    expect(() => S.bulkStudents.parse(many(2001))).toThrow();
  });
});

describe('a new school', () => {
  it('creates each child with their parent and stop in one pass', async () => {
    const db = fakeRosterDb({ routes: routes() });
    const { planned } = await importInto(db, [
      { line: 2, rfidTag: 'A-1', name: 'Asha Kumari', grade: '5A', guardianPhone: '9876543210', parentEmail: 'sunita@mail.com', parentName: 'Sunita Devi', route: 'route 1 kankarbagh', stop: 'RAJENDRA NAGAR' },
    ]);

    expect(publicPlan(planned)[0]).toMatchObject({
      line: 2, student: 'NEW', state: 'INVITE_READY', ready: true,
      parent: { action: 'NEW', email: 'sunita@mail.com' },
      stop: { action: 'ASSIGN', route: 'Route 1 Kankarbagh', stop: 'Rajendra Nagar' },
      card: 'GENERATED', errors: [],
    });
    expect(db.users[0]).toMatchObject({ email: 'sunita@mail.com', name: 'Sunita Devi', phone: '9876543210', role: 'PARENT', password: 'LOCKED', mustResetPassword: true });
    expect(db.students[0]).toMatchObject({ rfidTag: 'A-1', name: 'Asha Kumari', grade: '5A', parentId: db.users[0].id });
    expect(db.mappings[0]).toMatchObject({ studentId: db.students[0].id, routeStopId: 'st-a', direction: null });
  });

  it('makes one account for siblings who share a parent email', async () => {
    const db = fakeRosterDb({ routes: routes() });
    const { planned } = await importInto(db, [
      { rfidTag: 'A-1', name: 'Asha', parentEmail: 'sunita@mail.com', parentName: 'Sunita' },
      { rfidTag: 'A-2', name: 'Arun', parentEmail: 'SUNITA@mail.com', parentName: 'Sunita Devi' },
    ]);

    expect(db.users).toHaveLength(1);
    expect(db.students.map((s) => s.parentId)).toEqual([db.users[0].id, db.users[0].id]);
    expect(planned[1].warnings[0]).toMatch(/Row 1 names this parent Sunita/);
    expect(totals(planned)).toMatchObject({ new: 2, parentsCreated: 1 });
  });

  it('links a parent the school already has, however their email was typed', async () => {
    const db = fakeRosterDb({ routes: routes(), users: [{ id: 'u-old', email: 'Sunita@Mail.com', role: 'PARENT', schoolId: SCHOOL, phone: null }] });
    const { planned } = await importInto(db, [{ rfidTag: 'A-3', name: 'Anil', parentEmail: 'sunita@mail.com', guardianPhone: '9000000000' }]);

    expect(planned[0].state).toBe('EXISTING_PARENT_LINKED');
    expect(db.users).toHaveLength(1);
    expect(db.students[0].parentId).toBe('u-old');
    // Their phone was missing; the file had one, so WhatsApp invites can reach them.
    expect(db.users[0].phone).toBe('9000000000');
  });

  it('says plainly when a child has no parent email', async () => {
    const db = fakeRosterDb({ routes: routes() });
    const { planned } = await importInto(db, [{ rfidTag: 'A-4', name: 'Anu', parentName: 'Ravi' }]);
    expect(planned[0]).toMatchObject({ state: 'NO_PARENT', ready: false });
    expect(planned[0].warnings).toContain('Guardian name is only kept with a parent email.');
  });
});

describe('rows that need correcting', () => {
  const check = async (list, extra = {}) => {
    const db = fakeRosterDb({ routes: routes(), ...extra });
    const { planned } = await importInto(db, list);
    return { db, planned };
  };

  it.each([
    ['a Student ID twice in the file', [{ rfidTag: 'X', name: 'A' }, { rfidTag: 'x', name: 'B' }], /appears on more than one row/],
    ['a route nobody has', [{ rfidTag: 'X', name: 'A', route: 'Route 7', stop: 'Gate' }], /No route called "Route 7"/],
    ['a stop that route does not have', [{ rfidTag: 'X', name: 'A', route: 'Route 2', stop: 'Rajendra Nagar' }], /Route 2 has no stop called "Rajendra Nagar"/],
    ['a route with no stop', [{ rfidTag: 'X', name: 'A', route: 'Route 2' }], /A route needs a stop/],
    ['a card code twice', [{ rfidTag: 'X', name: 'A', qrToken: 'CARD-1' }, { rfidTag: 'Y', name: 'B', qrToken: 'CARD-1' }], /card code appears on more than one row/],
  ])('%s', async (_label, list, message) => {
    const { db, planned } = await check(list);
    expect(planned.some((p) => p.state === 'NEEDS_CORRECTION' && p.errors.some((e) => message.test(e)))).toBe(true);
    expect(db.writes).toEqual([]);
  });

  it('a route name two routes share', async () => {
    const extra = { routes: [...routes(), { id: 'r3', schoolId: SCHOOL, name: 'Route 2', stops: [] }] };
    const { planned } = await check([{ rfidTag: 'X', name: 'A', route: 'Route 2', stop: 'Boring Road' }], extra);
    expect(planned[0].errors[0]).toMatch(/More than one route is called "Route 2"/);
  });

  it('never matches another school\'s route of the same name', async () => {
    const { planned } = await check([{ rfidTag: 'X', name: 'A', route: 'Route 1 Kankarbagh', stop: 'Elsewhere' }]);
    expect(planned[0].errors[0]).toMatch(/has no stop called "Elsewhere"/);
  });

  it('a parent email that is a driver or another school\'s parent', async () => {
    const { planned } = await check([{ rfidTag: 'X', name: 'A', parentEmail: 'driver@example.com' }], {
      users: [{ id: 'd1', email: 'driver@example.com', role: 'DRIVER', schoolId: SCHOOL }],
    });
    expect(planned[0].errors[0]).toMatch(/belongs to another account/);
  });

  it('a Student ID another school uses', async () => {
    const { planned } = await check([{ rfidTag: 'R042', name: 'A' }], {
      students: [{ id: 'o1', schoolId: OTHER, rfidTag: 'R042', name: 'Someone', parentId: null }],
    });
    expect(planned[0].errors[0]).toMatch(/already in use/);
  });

  it('a card code already on another child', async () => {
    const { planned } = await check([{ rfidTag: 'NEW-1', name: 'A', qrToken: 'CARD-9' }], {
      students: [{ id: 'k1', schoolId: SCHOOL, rfidTag: 'K-1', name: 'Kavya', qrToken: 'CARD-9', qrCodeImported: true, parentId: null }],
    });
    expect(planned[0].errors[0]).toMatch(/already on Kavya's card/);
  });
});

describe('running a file again', () => {
  const file = [
    { rfidTag: 'A-1', name: 'Asha', grade: '5A', parentEmail: 'sunita@mail.com', route: 'Route 2', stop: 'Boring Road' },
    { rfidTag: 'A-2', name: 'Arun', parentEmail: 'sunita@mail.com' },
  ];

  it('changes nothing the second time', async () => {
    const db = fakeRosterDb({ routes: routes() });
    await importInto(db, file);
    const before = db.writes.length;

    const { planned, written } = await importInto(db, file);

    expect(planned.map((p) => p.student)).toEqual(['UNCHANGED', 'UNCHANGED']);
    expect(planned.map((p) => p.state)).toEqual(['PARENT_LINKED', 'PARENT_LINKED']);
    expect(planned[0].stop.action).toBe('ALREADY');
    expect(written).toBe(0);
    expect(db.writes.length).toBe(before);
    expect(db.users).toHaveLength(1);
    expect(db.students).toHaveLength(2);
  });

  it('fills what the first file left out, and nothing else', async () => {
    const db = fakeRosterDb({ routes: routes() });
    await importInto(db, [{ rfidTag: 'A-1', name: 'Asha' }]);

    const { planned } = await importInto(db, [
      { rfidTag: 'A-1', name: 'asha', grade: '5A', guardianPhone: '9876543210', parentEmail: 'sunita@mail.com', route: 'Route 2', stop: 'Boring Road' },
    ]);

    expect(planned[0]).toMatchObject({ student: 'UPDATE', state: 'INVITE_READY', ready: true });
    expect(planned[0].changes).toEqual(expect.arrayContaining(['parent account created', 'stop assigned', 'class added', 'guardian phone added']));
    expect(db.students).toHaveLength(1);
    expect(db.students[0]).toMatchObject({ grade: '5A', guardianPhone: '9876543210', parentId: db.users[0].id });
    expect(db.mappings).toHaveLength(1);
  });

  it('refuses to change a parent or a stop: that is a decision for the student page', async () => {
    const db = fakeRosterDb({ routes: routes() });
    await importInto(db, file);

    const { planned } = await importInto(db, [
      { rfidTag: 'A-1', name: 'Asha', parentEmail: 'someone.else@mail.com', route: 'Route 1 Kankarbagh', stop: 'Rajendra Nagar' },
    ]);

    expect(planned[0].state).toBe('NEEDS_CORRECTION');
    expect(planned[0].errors).toEqual([
      'Asha is already linked to sunita@mail.com. Change the parent on the student\'s page.',
      'Asha already rides from Boring Road (Route 2). Move the stop on the student\'s page.',
    ]);
  });

  it('catches an ID typed against the wrong child', async () => {
    const db = fakeRosterDb({ routes: routes() });
    await importInto(db, file);
    const { planned } = await importInto(db, [{ rfidTag: 'A-1', name: 'Rahul', parentEmail: 'rahul.dad@mail.com' }]);
    expect(planned[0].errors[0]).toBe('Student ID A-1 belongs to Asha, not Rahul. Check the ID.');
  });
});

describe('totals', () => {
  it('count what the office needs to act on', async () => {
    const db = fakeRosterDb({ routes: routes() });
    const planned = await planRoster(db, SCHOOL, rows([
      { rfidTag: 'A', name: 'A', parentEmail: 'a@x.com', route: 'Route 2', stop: 'Boring Road' },
      { rfidTag: 'B', name: 'B', parentEmail: 'a@x.com' },
      { rfidTag: 'C', name: 'C' },
      { rfidTag: 'D', name: 'D', route: 'Nowhere', stop: 'X' },
    ]));
    expect(totals(planned)).toEqual({
      rows: 4, new: 3, updated: 0, unchanged: 0, needsCorrection: 1,
      parentsCreated: 1, parentsLinked: 0, noParent: 1, stopsAssigned: 1, noStop: 2, ready: 1,
    });
  });
});
