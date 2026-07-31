const request = require('supertest');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'super-secret';

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: {
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

jest.mock('bcryptjs', () => ({
  hash: jest.fn(),
}));

const { app, prisma } = require('../server');

describe('POST /api/schools/:schoolId/drivers', () => {
  let token;

  beforeEach(() => {
    jest.clearAllMocks();
    token = jwt.sign({ id: 1, role: 'SUPER_ADMIN', schoolId: 10 }, process.env.JWT_SECRET);
    jest.spyOn(console, 'error').mockImplementation(() => {}); // Suppress error logs in output
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/schools/10/drivers')
      .send({
        name: 'John Driver',
        email: 'driver@test.com'
      });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized: Missing or invalid token' });
  });

  it('should create a driver and return it with a temp password', async () => {
    jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('deadbeef', 'hex'));
    bcrypt.hash.mockResolvedValue('hashed_deadbeef');

    const mockDriver = {
      id: 100,
      schoolId: '10',
      name: 'John Driver',
      email: 'driver@test.com',
      password: 'hashed_deadbeef',
      role: 'DRIVER',
    };
    prisma.user.create.mockResolvedValue(mockDriver);

    const res = await request(app)
      .post('/api/schools/10/drivers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'John Driver',
        email: 'driver@test.com'
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      driver: mockDriver,
      tempPassword: 'deadbeef'
    });

    expect(crypto.randomBytes).toHaveBeenCalledWith(4);
    expect(bcrypt.hash).toHaveBeenCalledWith('deadbeef', 10);
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        schoolId: '10',
        name: 'John Driver',
        email: 'driver@test.com',
        password: 'hashed_deadbeef',
        role: 'DRIVER'
      }
    });
  });

  it('should return 500 when database throws an error', async () => {
    jest.spyOn(crypto, 'randomBytes').mockReturnValue(Buffer.from('deadbeef', 'hex'));
    bcrypt.hash.mockResolvedValue('hashed_deadbeef');

    prisma.user.create.mockRejectedValue(new Error('Database error'));

    const res = await request(app)
      .post('/api/schools/10/drivers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'John Driver',
        email: 'driver@test.com'
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(console.error).toHaveBeenCalled();
  });
});
