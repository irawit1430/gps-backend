const request = require('supertest');
const { app, prisma } = require('../server');
const jwt = require('jsonwebtoken');

jest.mock('@prisma/client', () => {
  const mockPrisma = {
    student: { findMany: jest.fn() },
    attendanceLog: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

const SECRET = process.env.JWT_SECRET;
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const admin = () => jwt.sign({ id: 'a1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL }, SECRET);

beforeEach(() => jest.resetAllMocks());

// The roster flattened each child to a route NAME and a stop NAME, so the dashboard had
// no id to move or remove an assignment with — it had to read them off the parents
// endpoint, which is the wrong screen's payload.
describe('the students list carries actionable mappings', () => {
  it('returns ids, coordinates and direction for every assignment', async () => {
    prisma.student.findMany.mockResolvedValue([
      {
        id: 's1', rfidTag: 'T1', name: 'Asha', grade: '5th', photoUrl: null,
        guardianPhone: null, parent: null, qrCodeImported: false,
        routeMappings: [
          {
            id: 'm1', routeStopId: 'stop-am', direction: 'TO_SCHOOL',
            routeStop: { id: 'stop-am', name: 'Oak St', lat: 12.9, lng: 77.6, routeId: 'r1', route: { name: 'Route 1' } },
          },
          {
            id: 'm2', routeStopId: 'stop-pm', direction: 'FROM_SCHOOL',
            routeStop: { id: 'stop-pm', name: 'Elm St', lat: 12.8, lng: 77.5, routeId: 'r1', route: { name: 'Route 1' } },
          },
        ],
      },
    ]);
    prisma.attendanceLog.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL}/students`)
      .set('Authorization', `Bearer ${admin()}`);

    expect(res.status).toBe(200);
    expect(res.body[0].mappings).toEqual([
      { id: 'm1', routeStopId: 'stop-am', direction: 'TO_SCHOOL', stopName: 'Oak St', lat: 12.9, lng: 77.6, routeId: 'r1', routeName: 'Route 1' },
      { id: 'm2', routeStopId: 'stop-pm', direction: 'FROM_SCHOOL', stopName: 'Elm St', lat: 12.8, lng: 77.5, routeId: 'r1', routeName: 'Route 1' },
    ]);
    // The single-stop fields stay exactly as they were, so nothing reading them breaks.
    expect(res.body[0].assignedRoute).toBe('Route 1');
    expect(res.body[0].routeStopName).toBe('Oak St');
  });

  // Always present, so the dashboard never has to guard for undefined.
  it('returns an empty array for an unassigned child', async () => {
    prisma.student.findMany.mockResolvedValue([
      {
        id: 's2', rfidTag: 'T2', name: 'Rahul', grade: '6th', photoUrl: null,
        guardianPhone: null, parent: null, qrCodeImported: false, routeMappings: [],
      },
    ]);
    prisma.attendanceLog.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/schools/${SCHOOL}/students`)
      .set('Authorization', `Bearer ${admin()}`);

    expect(res.status).toBe(200);
    expect(res.body[0].mappings).toEqual([]);
    expect(res.body[0].assignedRoute).toBe('Unassigned');
  });
});
