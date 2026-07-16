const request = require('supertest');
const { PrismaClient } = require('@prisma/client');

jest.mock('@prisma/client', () => {
  const mPrismaClient = {
    leaveApplication: {
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

const prisma = new PrismaClient();
const app = require('../server.js');

describe('POST /api/leaves', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully create a leave application and return 200', async () => {
    const mockLeave = {
      id: 1,
      studentId: 'student-123',
      startDate: new Date('2023-10-01').toISOString(),
      endDate: new Date('2023-10-05').toISOString(),
      reason: 'Sick leave',
      notes: 'Doctor note attached',
      status: 'PENDING',
    };

    prisma.leaveApplication.create.mockResolvedValueOnce(mockLeave);

    const response = await request(app)
      .post('/api/leaves')
      .send({
        studentId: 'student-123',
        startDate: '2023-10-01',
        endDate: '2023-10-05',
        reason: 'Sick leave',
        notes: 'Doctor note attached',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockLeave);
    expect(prisma.leaveApplication.create).toHaveBeenCalledTimes(1);
    expect(prisma.leaveApplication.create).toHaveBeenCalledWith({
      data: {
        studentId: 'student-123',
        startDate: new Date('2023-10-01'),
        endDate: new Date('2023-10-05'),
        reason: 'Sick leave',
        notes: 'Doctor note attached',
        status: 'PENDING',
      },
    });
  });

  it('should return 500 when database throws an error', async () => {
    prisma.leaveApplication.create.mockRejectedValueOnce(new Error('Database error'));

    const response = await request(app)
      .post('/api/leaves')
      .send({
        studentId: 'student-123',
        startDate: '2023-10-01',
        endDate: '2023-10-05',
        reason: 'Sick leave',
        notes: 'Doctor note attached',
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Database error' });
    expect(prisma.leaveApplication.create).toHaveBeenCalledTimes(1);
  });
});
