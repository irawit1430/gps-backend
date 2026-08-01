const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, prisma } = require('../server');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    student: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    }
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

describe('GET /api/schools/:schoolId/students', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: 1, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET || 'super-secret');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return students with no route assigned', async () => {
    const mockStudents = [
      {
        id: 1,
        rfidTag: 'TAG1',
        name: 'Student 1',
        grade: '5th',
        photoUrl: 'url1',
        routeMappings: []
      }
    ];
    prisma.student.findMany.mockResolvedValue(mockStudents);

    const res = await request(app)
      .get('/api/schools/1/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 1,
        rfidTag: 'TAG1',
        name: 'Student 1',
        grade: '5th',
        photoUrl: 'url1',
        assignedRoute: 'Unassigned',
        routeStopName: 'Unassigned',
        boardingStatus: 'Absent',
        lastCheckIn: '--:--'
      }
    ]);
    expect(prisma.student.findMany).toHaveBeenCalledWith({
      where: { schoolId: '1' },
      include: { routeMappings: { include: { routeStop: { include: { route: true } } } } }
    });
  });

  it('should return students with route and route stop assigned', async () => {
    const mockStudents = [
      {
        id: 2,
        rfidTag: 'TAG2',
        name: 'Student 2',
        grade: '6th',
        photoUrl: 'url2',
        routeMappings: [
          {
            routeStop: {
              name: 'Stop A',
              route: {
                name: 'Route 1'
              }
            }
          }
        ]
      }
    ];
    prisma.student.findMany.mockResolvedValue(mockStudents);

    const res = await request(app)
      .get('/api/schools/2/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 2,
        rfidTag: 'TAG2',
        name: 'Student 2',
        grade: '6th',
        photoUrl: 'url2',
        assignedRoute: 'Route 1',
        routeStopName: 'Stop A',
        boardingStatus: 'Absent',
        lastCheckIn: '--:--'
      }
    ]);
  });

  it('should return 500 when database throws an error', async () => {
    prisma.student.findMany.mockRejectedValue(new Error('Database error'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .get('/api/schools/1/students')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    console.error.mockRestore();
  });
});

describe('POST /api/schools/:schoolId/students', () => {
  let token;

  beforeAll(() => {
    token = jwt.sign({ id: 1, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET || 'super-secret');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a student without a parent when parentEmail is not provided', async () => {
    const mockStudent = {
      id: 1,
      schoolId: 'school-1',
      rfidTag: 'TAG-123',
      name: 'John Doe',
      grade: 'General',
      parentId: null
    };
    prisma.student.create.mockResolvedValue(mockStudent);

    const res = await request(app)
      .post('/api/schools/school-1/students')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'John Doe', rfidTag: 'TAG-123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      student: mockStudent,
      parentCredentials: null
    });
    expect(prisma.student.create).toHaveBeenCalledWith({
      data: {
        schoolId: 'school-1',
        rfidTag: 'TAG-123',
        name: 'John Doe',
        grade: 'General',
        parentId: null
      }
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('should link existing parent (skip invite) when parentEmail is provided and parent exists', async () => {
    const existingParent = { id: 'parent-1', email: 'parent@test.com' };
    const mockStudent = {
      id: 1,
      schoolId: 'school-1',
      rfidTag: 'TAG-123',
      name: 'John Doe',
      grade: 'General',
      parentId: existingParent.id
    };

    prisma.user.findUnique.mockResolvedValue(existingParent);
    prisma.student.create.mockResolvedValue(mockStudent);

    const res = await request(app)
      .post('/api/schools/school-1/students')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'John Doe', parentEmail: 'parent@test.com' });

    expect(res.status).toBe(200);
    expect(res.body.parentCredentials).toBeNull();
    expect(res.body.student).toEqual(mockStudent);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'parent@test.com' }
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.student.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'parent-1' })
      })
    );
  });

  it('should create new parent (auto-invite) when parentEmail is provided and parent does not exist', async () => {
    const newParent = { id: 'parent-new', email: 'newparent@test.com' };
    const mockStudent = {
      id: 1,
      schoolId: 'school-1',
      rfidTag: 'TAG-123',
      name: 'John Doe',
      grade: 'General',
      parentId: newParent.id
    };

    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(newParent);
    prisma.student.create.mockResolvedValue(mockStudent);

    const res = await request(app)
      .post('/api/schools/school-1/students')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'John Doe', parentEmail: 'newparent@test.com' });

    expect(res.status).toBe(200);
    expect(res.body.parentCredentials).toEqual(
      expect.objectContaining({
        email: 'newparent@test.com',
        temporaryPassword: expect.any(String)
      })
    );
    expect(res.body.student).toEqual(mockStudent);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'newparent@test.com' }
    });
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'newparent@test.com',
          role: 'PARENT',
          schoolId: 'school-1'
        })
      })
    );
  });

  it('should return 400 when schoolId is missing', async () => {
    // using /api/students directly without schoolId in body or route
    // Note that we mock token with schoolId usually, but here the token has only id and role
    const res = await request(app)
      .post('/api/students')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'John Doe' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'schoolId is required' });
  });

  it('should return 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/schools/school-1/students')
      .set('Authorization', `Bearer ${token}`)
      .send({ });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Student name is required' });
  });

  it('should return 400 for duplicate RFID tag', async () => {
    const error = new Error();
    error.code = 'P2002';
    prisma.student.create.mockRejectedValue(error);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/schools/school-1/students')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'John Doe', rfidTag: 'DUP-TAG' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'RFID Tag is already assigned to another student. Please enter a unique RFID Tag.' });

    console.error.mockRestore();
  });

  it('should return 500 when database throws generic error', async () => {
    prisma.student.create.mockRejectedValue(new Error('Generic DB Error'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/schools/school-1/students')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'John Doe', rfidTag: 'TAG-1' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    console.error.mockRestore();
  });
});
