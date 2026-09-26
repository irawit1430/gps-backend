// Every family gets its own invite: the app link, their email and a one-time code that
// expires. Sending again replaces the code; revoking kills it. How it went out is
// recorded honestly: by email the server knows; by WhatsApp, SMS or print only staff do.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(async (fn) => (typeof fn === 'function' ? fn(mockPrisma) : Promise.all(fn))),
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});
jest.mock('../mailer', () => ({ isConfigured: jest.fn(() => false), sendMail: jest.fn(), sendMailTo: jest.fn() }));

const { app, prisma } = require('../server');
const mailer = require('../mailer');
const config = require('../config');
const { stageOf, inviteMessage } = require('../parentInvites');

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const PARENT = '33333333-3333-4333-8333-333333333333';
const admin = jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);

const parent = (over = {}) => ({
  id: PARENT, role: 'PARENT', schoolId: SCHOOL, name: 'Sunita Devi', email: 'sunita@mail.com', phone: null,
  mustResetPassword: true, inviteSentAt: null, inviteExpiresAt: null, inviteChannel: null, lastLoginAt: null,
  parentStudents: [{ name: 'Asha', guardianPhone: '9876543210' }, { name: 'Arun', guardianPhone: null }],
  school: { name: 'DAV Public School', timezone: 'Asia/Kolkata' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mailer.isConfigured.mockReturnValue(false);
  prisma.user.update.mockResolvedValue({});
});

const invite = (channel, id = PARENT) =>
  request(app).post(`/api/parents/${id}/invite`).set('Authorization', `Bearer ${admin}`).send({ channel });
const stored = (call = 0) => prisma.user.update.mock.calls[call][0].data;

describe('where a family stands', () => {
  const now = new Date('2026-09-27T10:00:00Z');
  it.each([
    ['chose their own password', { mustResetPassword: false }, 'ACTIVATED'],
    ['never invited', { mustResetPassword: true }, 'NOT_INVITED'],
    ['invite sent, unused', { mustResetPassword: true, inviteSentAt: '2026-09-26T10:00:00Z', inviteExpiresAt: '2026-10-03T10:00:00Z' }, 'INVITE_SENT'],
    ['signed in with the code, no password yet', { mustResetPassword: true, inviteSentAt: '2026-09-26T10:00:00Z', inviteExpiresAt: '2026-10-03T10:00:00Z', lastLoginAt: '2026-09-26T11:00:00Z' }, 'SIGNED_IN'],
    ['code ran out', { mustResetPassword: true, inviteSentAt: '2026-09-10T10:00:00Z', inviteExpiresAt: '2026-09-17T10:00:00Z' }, 'INVITE_EXPIRED'],
    ['email bounced', { mustResetPassword: true, inviteChannel: 'EMAIL_FAILED' }, 'EMAIL_FAILED'],
    ['invite taken back', { mustResetPassword: true, inviteChannel: 'REVOKED', inviteExpiresAt: '2026-09-20T10:00:00Z' }, 'NOT_INVITED'],
  ])('%s', (_label, user, stage) => {
    expect(stageOf(user, now)).toBe(stage);
  });
});

describe('the invite text', () => {
  const base = { parentName: 'Sunita Devi', email: 'sunita@mail.com', code: 'Ab3dEf7hJk', schoolName: 'DAV Public School', childNames: ['Asha', 'Arun'], expiresAt: new Date('2026-10-04T06:00:00Z') };

  it('says who, what, the code, and when it runs out', () => {
    const { text, subject, html } = inviteMessage({ ...base, links: { android: 'https://play.google.com/store/apps/details?id=com.voltava.in', ios: null } });
    expect(subject).toBe('DAV Public School: your Voltava parent app invite');
    expect(text).toContain("Asha and Arun's school bus");
    expect(text).toContain('Sign in with your email: sunita@mail.com');
    expect(text).toContain('One-time code: Ab3dEf7hJk');
    expect(text).toContain('expires on 4 Oct 2026');
    expect(text).toContain('Android: https://play.google.com/store/apps/details?id=com.voltava.in');
    expect(html).toContain('Ab3dEf7hJk');
  });

  it('does not invent a store link it was not given', () => {
    const { text } = inviteMessage({ ...base, links: {} });
    expect(text).toContain('from the Play Store or App Store');
    expect(text).not.toMatch(/https?:/);
  });

  it('escapes what it puts in HTML', () => {
    const { html } = inviteMessage({ ...base, schoolName: '<b>X</b>', links: {} });
    expect(html).not.toContain('<b>X</b>');
  });
});

describe('POST /api/parents/:id/invite by a staff channel', () => {
  it('makes a code that is now the account password, good for PARENT_INVITE_DAYS', async () => {
    prisma.user.findUnique.mockResolvedValue(parent());
    const before = Date.now();

    const res = await invite('WHATSAPP');

    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[A-HJ-NP-Za-hj-np-z2-9]{10}$/);
    const data = stored();
    expect(await bcrypt.compare(res.body.code, data.password)).toBe(true);
    expect(data).toMatchObject({ mustResetPassword: true, inviteChannel: 'WHATSAPP' });
    expect(data.inviteSentAt).toBeInstanceOf(Date);
    const days = (data.inviteExpiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(config.PARENT_INVITE_DAYS - 0.01);
    expect(days).toBeLessThan(config.PARENT_INVITE_DAYS + 0.01);
    // The number on the child's record, since the parent's own is missing.
    expect(res.body.phone).toBe('9876543210');
    expect(res.body.message.text).toContain(res.body.code);
  });

  it('refuses a parent who has already chosen a password', async () => {
    prisma.user.findUnique.mockResolvedValue(parent({ mustResetPassword: false }));
    const res = await invite('SMS');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ACTIVE');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses another school\'s parent', async () => {
    prisma.user.findUnique.mockResolvedValue(parent({ schoolId: 'another' }));
    const res = await invite('COPY');
    expect(res.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a channel it does not know', async () => {
    const res = await invite('PIGEON');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/parents/:id/invite by email', () => {
  it('says so when the server has no email set up, and changes nothing', async () => {
    prisma.user.findUnique.mockResolvedValue(parent());
    const res = await invite('EMAIL');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_OFF');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('sends it, records it, and keeps the code out of the response', async () => {
    mailer.isConfigured.mockReturnValue(true);
    mailer.sendMail.mockResolvedValue(true);
    prisma.user.findUnique.mockResolvedValue(parent());

    const res = await invite('EMAIL');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ channel: 'EMAIL', sent: true });
    expect(res.body.code).toBeUndefined();
    const mail = mailer.sendMail.mock.calls[0][0];
    expect(mail.to).toBe('sunita@mail.com');
    const code = mail.text.match(/One-time code: (\S+)/)[1];
    expect(await bcrypt.compare(code, stored(0).password)).toBe(true);
    expect(stored(1)).toMatchObject({ inviteChannel: 'EMAIL' });
    expect(stored(1).inviteSentAt).toBeInstanceOf(Date);
  });

  it('records a failed email as failed, never as sent', async () => {
    mailer.isConfigured.mockReturnValue(true);
    mailer.sendMail.mockResolvedValue(false);
    prisma.user.findUnique.mockResolvedValue(parent());

    const res = await invite('EMAIL');

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('EMAIL_FAILED');
    expect(stored(1)).toEqual({ inviteSentAt: null, inviteChannel: 'EMAIL_FAILED' });
  });
});

describe('POST /api/schools/:id/parent-invites (printed letters)', () => {
  it('makes a letter per family and skips the ones already in', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    prisma.user.findMany.mockResolvedValue([parent(), parent({ id: other, mustResetPassword: false })]);

    const res = await request(app).post(`/api/schools/${SCHOOL}/parent-invites`).set('Authorization', `Bearer ${admin}`)
      .send({ parentIds: [PARENT, other], channel: 'PRINT' });

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(res.body.letters).toHaveLength(1);
    expect(res.body.letters[0]).toMatchObject({ parentId: PARENT, email: 'sunita@mail.com', childNames: ['Asha', 'Arun'] });
    expect(res.body.skipped).toEqual([{ parentId: other, reason: 'ALREADY_ACTIVE', error: expect.any(String) }]);
    // Only this school's parents are even looked at.
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ schoolId: SCHOOL });
  });
});

describe('POST /api/parents/:id/invite/revoke', () => {
  it('kills the code at once', async () => {
    prisma.user.findUnique.mockResolvedValue(parent({ inviteSentAt: new Date(), inviteChannel: 'WHATSAPP' }));
    const res = await request(app).post(`/api/parents/${PARENT}/invite/revoke`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ mustResetPassword: true, inviteSentAt: null, inviteChannel: 'REVOKED' });
    expect(stored().inviteExpiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('signing in with an invite', () => {
  const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });

  it('works with a code that is still good, and asks for a new password', async () => {
    const hash = await bcrypt.hash('Ab3dEf7hJk', 4);
    prisma.user.findUnique.mockResolvedValue({ ...parent(), password: hash, inviteExpiresAt: new Date(Date.now() + 86_400_000) });

    const res = await login('sunita@mail.com', 'Ab3dEf7hJk');

    expect(res.status).toBe(200);
    expect(res.body.user.mustResetPassword).toBe(true);
    expect(jwt.decode(res.body.token).mustResetPassword).toBe(true);
  });

  it('refuses a code past its date, and says what to do', async () => {
    const hash = await bcrypt.hash('Ab3dEf7hJk', 4);
    prisma.user.findUnique.mockResolvedValue({ ...parent(), password: hash, inviteExpiresAt: new Date(Date.now() - 1000) });

    const res = await login('sunita@mail.com', 'Ab3dEf7hJk');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVITE_EXPIRED');
    expect(res.body.error).toMatch(/Ask your school/);
  });

  it('gives nothing away to a wrong code on an expired invite', async () => {
    const hash = await bcrypt.hash('Ab3dEf7hJk', 4);
    prisma.user.findUnique.mockResolvedValue({ ...parent(), password: hash, inviteExpiresAt: new Date(Date.now() - 1000) });
    const res = await login('sunita@mail.com', 'wrong-code');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('finds a lowercased account when the phone capitalised the email', async () => {
    const hash = await bcrypt.hash('Ab3dEf7hJk', 4);
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where.email === 'sunita@mail.com' ? { ...parent(), password: hash, inviteExpiresAt: null } : null));

    const res = await login('Sunita@mail.com', 'Ab3dEf7hJk');

    expect(res.status).toBe(200);
  });

  it('forgets the expiry once the parent chooses a password', async () => {
    const hash = await bcrypt.hash('Ab3dEf7hJk', 4);
    prisma.user.findUnique.mockResolvedValue({ ...parent(), password: hash });
    // Signed after the invites above revoked this parent's older sessions, as a real
    // sign-in with the code would be.
    const token = jwt.sign({ id: PARENT, role: 'PARENT', schoolId: SCHOOL, mustResetPassword: true, iat: Math.floor(Date.now() / 1000) + 2 }, SECRET);

    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'Ab3dEf7hJk', newPassword: 'MyOwnPassword9' });

    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ mustResetPassword: false, inviteExpiresAt: null });
  });
});
