jest.mock('child_process', () => ({
  execSync: jest.fn()
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn()
}));

const mockFindUnique = jest.fn();
jest.mock('@prisma/client', () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => {
      return {
        user: {
          findUnique: mockFindUnique
        }
      };
    })
  };
});

const request = require('supertest');
const { app } = require('../server.js');
const bcrypt = require('bcryptjs');

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 on non-existent user', async () => {
    mockFindUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'password123' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('should return 401 on incorrect password', async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: 1,
      email: 'test@example.com',
      password: 'hashedpassword',
      role: 'ADMIN',
      schoolId: 'school-123'
    });

    bcrypt.compare.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    expect(bcrypt.compare).toHaveBeenCalledWith('wrongpassword', 'hashedpassword');
  });

  it('should return 200 and a token on valid credentials', async () => {
    mockFindUnique.mockResolvedValueOnce({
      id: 1,
      email: 'test@example.com',
      name: 'Test Admin',
      password: 'hashedpassword',
      role: 'ADMIN',
      schoolId: 'school-123'
    });

    bcrypt.compare.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'correctpassword' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toEqual({
      id: 1,
      role: 'ADMIN',
      name: 'Test Admin',
      email: 'test@example.com',
      schoolId: 'school-123'
    });
  });
});
