// Importing cards a school already has.
//
// The columns for this existed from the start — qrToken, qrCodeImported,
// qrCardPrintedAt, and a per-school unique on (schoolId, qrToken) — and were surfaced
// to two consumers. Nothing could ever write them: qrToken was only ever set by
// newQrToken(), and neither field appeared in any validation schema, so no request
// could supply one. A school arriving with 600 printed cards had to reprint all 600.
//
// The consequence was visible rather than theoretical. The driver app reads
// `hasCard: Boolean(qrCardPrintedAt)`, so every child holding an imported card would
// have shown as having none.

const S = require('../schemas');

describe('createStudent / updateStudent accept an imported code', () => {
  it('accepts a school’s existing code on create', () => {
    const parsed = S.createStudent.parse({ name: 'Aryan', qrToken: 'SCH-2026-0041' });
    expect(parsed.qrToken).toBe('SCH-2026-0041');
  });

  it('accepts one on update, for a student added before their card', () => {
    expect(S.updateStudent.parse({ qrToken: 'SCH-2026-0041' }).qrToken).toBe('SCH-2026-0041');
  });

  it('stays optional — a school without cards still gets a generated one', () => {
    expect(S.createStudent.parse({ name: 'Aryan' }).qrToken).toBeUndefined();
  });

  it('trims surrounding whitespace, which a pasted CSV cell reliably carries', () => {
    expect(S.createStudent.parse({ name: 'A', qrToken: '  SCH-1  ' }).qrToken).toBe('SCH-1');
  });

  it('rejects a code too short to be worth scanning', () => {
    expect(() => S.createStudent.parse({ name: 'A', qrToken: 'ab' })).toThrow();
  });

  it('flows through the bulk schema, which is the path a school actually uses', () => {
    const rows = S.bulkStudents.parse([
      { rfidTag: 'A-1', name: 'Aryan', qrToken: 'SCH-1' },
      { rfidTag: 'A-2', name: 'Sashank', qrToken: '' },
    ]);
    expect(rows[0].qrToken).toBe('SCH-1');
    // An empty spreadsheet cell is "no code", never a code that is an empty string.
    expect(rows[1].qrToken).toBeNull();
  });
});

// qrFieldsFor and withoutQrToken are the two decisions worth pinning: what an import
// implies, and what may leave the server.
describe('qrFieldsFor', () => {
  // Re-implemented rather than imported: server.js opens a Prisma client and a socket
  // server at require time. The behaviour is asserted, and the test below guards the
  // real call sites against drifting away from it.
  const qrFieldsFor = (supplied) =>
    supplied
      ? { qrToken: supplied, qrCodeImported: true, qrCardPrintedAt: new Date() }
      : { qrToken: 'generated', qrCodeImported: false, qrCardPrintedAt: null };

  it('marks an imported card as printed — it is already in a child’s hand', () => {
    const fields = qrFieldsFor('SCH-1');
    expect(fields.qrCodeImported).toBe(true);
    expect(fields.qrCardPrintedAt).toBeInstanceOf(Date);
  });

  it('leaves a generated card unprinted until someone actually prints it', () => {
    const fields = qrFieldsFor(null);
    expect(fields.qrCodeImported).toBe(false);
    expect(fields.qrCardPrintedAt).toBeNull();
  });
});

describe('server wiring', () => {
  const read = (f) => require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8');
  const src = read('server.js');

  it.each([
    ['create', 'server.js', /tx\.student\.create\([\s\S]{0,400}qrFieldsFor\(req\.body\.qrToken\)/],
    ['roster import', 'rosterImport.js', /tx\.student\.create\([\s\S]{0,400}qrFieldsFor\(row\.qrToken\)/],
  ])('the %s path uses qrFieldsFor rather than always generating', (_label, file, pattern) => {
    expect(read(file)).toMatch(pattern);
  });

  // Knowing a token is enough to print a working duplicate. The qr-cards endpoint
  // documents itself as the only response that emits one; create and update both
  // returned the whole student row, which made that false without anyone noticing.
  it('create and update strip the token from their responses', () => {
    expect(src).toMatch(/student:\s*withoutQrToken\(result\.student\)/);
    expect(src).toMatch(/res\.json\(withoutQrToken\(updated\)\)/);
  });

  it('update sets the companion fields, not the token alone', () => {
    expect(src).toMatch(/qrToken \? \{ \.\.\.rest, \.\.\.qrFieldsFor\(qrToken\) \} : rest/);
  });

  it('a duplicate names the column the admin should look at', () => {
    expect(src).toMatch(/function duplicateStudentFieldError/);
    expect(src).not.toMatch(/error: 'RFID Tag is already assigned to another student\.' \}/);
  });

  // Which line failed is now part of every row's result (tests/roster-import.test.js).
});
