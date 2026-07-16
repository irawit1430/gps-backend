const { seedDatabase, prisma, TOTAL_BUSES, STUDENTS_PER_BUS } = require('./simulate');

// Mock console.log so we don't spam test output
console.log = jest.fn();

jest.mock('@prisma/client', () => {
  const mPrismaClient = {
    school: { create: jest.fn() },
    bus: { create: jest.fn() },
    route: { create: jest.fn() },
    student: { create: jest.fn() }
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

describe('simulate.js seedDatabase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should seed database correctly with 1 school, 10 buses, 1 route, and 400 students', async () => {
    // Setup mock returns
    const mockSchoolId = 1;
    prisma.school.create.mockResolvedValue({ id: mockSchoolId });

    // Have bus.create return unique bus IDs
    let busIdCounter = 1;
    prisma.bus.create.mockImplementation(() => Promise.resolve({ id: busIdCounter++ }));

    prisma.route.create.mockResolvedValue({ id: 1 });
    prisma.student.create.mockResolvedValue({ id: 1 });

    const buses = await seedDatabase();

    // Verify school
    expect(prisma.school.create).toHaveBeenCalledTimes(1);
    expect(prisma.school.create).toHaveBeenCalledWith({
      data: {
        name: 'Springfield Elementary Simulation',
        address: '742 Evergreen Terrace'
      }
    });

    // Verify buses
    expect(prisma.bus.create).toHaveBeenCalledTimes(TOTAL_BUSES);
    for (let i = 1; i <= TOTAL_BUSES; i++) {
      expect(prisma.bus.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            schoolId: mockSchoolId,
            licensePlate: `MH-12-AB-${1000 + i}`,
            capacity: STUDENTS_PER_BUS,
            deviceId: `TM100-SIM-${i}`
          })
        })
      );
    }
    expect(buses).toHaveLength(TOTAL_BUSES);

    // Verify route
    expect(prisma.route.create).toHaveBeenCalledTimes(1);
    expect(prisma.route.create).toHaveBeenCalledWith({
      data: {
        schoolId: mockSchoolId,
        name: 'Morning Simulation Route'
      }
    });

    // Verify students
    const totalStudents = TOTAL_BUSES * STUDENTS_PER_BUS;
    expect(prisma.student.create).toHaveBeenCalledTimes(totalStudents);

    // Check first and last student created for brevity instead of looping all 400
    expect(prisma.student.create).toHaveBeenNthCalledWith(1, {
      data: {
        schoolId: mockSchoolId,
        name: 'Simulated Student 1',
        rfidTag: 'RFID-1-1'
      }
    });

    expect(prisma.student.create).toHaveBeenNthCalledWith(totalStudents, {
      data: {
        schoolId: mockSchoolId,
        name: `Simulated Student ${totalStudents}`,
        rfidTag: `RFID-${TOTAL_BUSES}-${STUDENTS_PER_BUS}`
      }
    });
  });
});
