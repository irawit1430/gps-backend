const fs = require('fs');
const content = fs.readFileSync('tests/drivers.test.js', 'utf8');

const targetMock = `    user: {
      findMany: jest.fn(),
    },`;

const newMock = `    user: {
      findMany: jest.fn(),
      create: jest.fn(),
    },`;

const targetEndOfTests = `    consoleSpy.mockRestore();
  });
});`;

const newTestBlock = `    consoleSpy.mockRestore();
  });
});

describe('POST /api/schools/:schoolId/drivers', () => {
  let token;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    token = jwt.sign({ id: 1, role: 'ADMIN', schoolId: 'school-1' }, process.env.JWT_SECRET);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 if unauthorized', async () => {
    const res = await request(app)
      .post('/api/schools/school-1/drivers')
      .send({ name: 'New Driver', email: 'driver@test.com', password: 'securepassword' });
    expect(res.status).toBe(401);
  });

  it('should return 200 and create driver when authorized', async () => {
    const mockCreatedDriver = { id: 3, name: 'New Driver', role: 'DRIVER', schoolId: 'school-1' };
    prisma.user.create.mockResolvedValue(mockCreatedDriver);

    const res = await request(app)
      .post('/api/schools/school-1/drivers')
      .set('Authorization', \`Bearer \${token}\`)
      .send({ name: 'New Driver', email: 'driver@test.com', password: 'securepassword' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockCreatedDriver);
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          schoolId: 'school-1',
          name: 'New Driver',
          email: 'driver@test.com',
          role: 'DRIVER'
        })
      })
    );
  });

  it('should return 500 when database throws an error', async () => {
    prisma.user.create.mockRejectedValue(new Error('Database error'));

    // Suppress console.error in tests to keep output clean
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/api/schools/school-1/drivers')
      .set('Authorization', \`Bearer \${token}\`)
      .send({ name: 'New Driver', email: 'driver@test.com', password: 'securepassword' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    consoleSpy.mockRestore();
  });
});`;

if (!content.includes(targetMock) || !content.includes(targetEndOfTests)) {
  console.error("Target blocks not found in tests/drivers.test.js");
  process.exit(1);
}

let updatedContent = content.replace(targetMock, newMock);
updatedContent = updatedContent.replace(targetEndOfTests, newTestBlock);
fs.writeFileSync('tests/drivers.test.js', updatedContent, 'utf8');
console.log('Successfully patched tests/drivers.test.js');
