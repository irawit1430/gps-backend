const request = require('supertest');
const jwt = require('jsonwebtoken');

// Mock prisma before importing app
jest.mock('@prisma/client', () => {
  const mockPrisma = {
    user: {
      update: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const { app, prisma } = require('../server');

describe('PATCH /api/parents/:id/preferences', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: 'parent-123', role: 'PARENT' }, process.env.JWT_SECRET || 'super-secret');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should update parent preferences successfully', async () => {
    const mockPreferences = { email: true, push: false, sms: true };
    const mockUser = {
      id: 'parent-123',
      notificationSettings: JSON.stringify(mockPreferences)
    };
    prisma.user.update.mockResolvedValue(mockUser);

    const res = await request(app)
      .patch('/api/parents/parent-123/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send(mockPreferences);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preferences: mockPreferences });
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'parent-123' },
      data: { notificationSettings: JSON.stringify(mockPreferences) }
    });
  });

  it('should handle internal server errors', async () => {
    prisma.user.update.mockRejectedValue(new Error('Database error'));

    // Silence console.error for this test to avoid cluttering test output
    const originalConsoleError = console.error;
    console.error = jest.fn();

    const res = await request(app)
      .patch('/api/parents/parent-123/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: true });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    // Restore console.error
    console.error = originalConsoleError;
  });
});
