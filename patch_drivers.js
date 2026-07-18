const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(
  `app.get('/api/schools/:schoolId/drivers', async (req, res) => {
  try {
    const drivers = await prisma.user.findMany({
      where: { schoolId: req.params.schoolId, role: "DRIVER" },
      include: {
        driverTrips: {
          where: { status: { in: ["PLANNED", "ON_SCHEDULE"] } },
          include: { bus: true, route: true }
        }
      }
    });`,
  `app.get('/api/schools/:schoolId/drivers', async (req, res) => {
  try {
    const drivers = await prisma.user.findMany({
      where: { schoolId: req.params.schoolId, role: "DRIVER" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        photoUrl: true,
        notificationSettings: true,
        schoolId: true,
        createdAt: true,
        updatedAt: true,
        driverTrips: {
          where: { status: { in: ["PLANNED", "ON_SCHEDULE"] } },
          include: { bus: true, route: true }
        }
      }
    });`
);

fs.writeFileSync('server.js', code);
