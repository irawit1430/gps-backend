const request = require('supertest');
const { app, prisma } = require('../server');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Mock prisma and bcryptjs
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
}));

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when user is not found', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@test.com', password: 'password123' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'nonexistent@test.com' } });
  });

  it('should return 401 when password does not match', async () => {
    const mockUser = {
      id: 1,
      email: 'user@test.com',
      password: 'hashedpassword',
      role: 'ADMIN',
      schoolId: 10,
    };
    prisma.user.findUnique.mockResolvedValue(mockUser);
    bcrypt.compare.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@test.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(bcrypt.compare).toHaveBeenCalledWith('wrongpassword', 'hashedpassword');
  });

  it('should return 200 and a JWT token when valid credentials are provided', async () => {
    const mockUser = {
      id: 1,
      name: 'Test User',
      email: 'user@test.com',
      password: 'hashedpassword',
      role: 'ADMIN',
      schoolId: 10,
    };
    prisma.user.findUnique.mockResolvedValue(mockUser);
    bcrypt.compare.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@test.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toEqual({
      id: 1,
      role: 'ADMIN',
      name: 'Test User',
      email: 'user@test.com',
      schoolId: 10,
      mustResetPassword: false,
      preferences: {}
    });

    // verify the token payload
    const decoded = jwt.decode(res.body.token);
    expect(decoded).toMatchObject({
      id: 1,
      role: 'ADMIN',
      schoolId: 10
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@test.com', password: 'password123' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('POST /api/auth/logout (token revocation)', () => {
  const sign = () =>
    jwt.sign({ id: 'u-logout', role: 'SUPER_ADMIN', schoolId: null }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '1h',
    });

  it('should return 401 without a token', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });

  it('should logout and then reject the same token on the next request', async () => {
    const token = sign();

    const ok = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);

    // Re-using the now-revoked token must fail.
    const reused = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(reused.status).toBe(401);
    expect(reused.body).toEqual({ error: 'Unauthorized: token has been revoked' });
  });
});
