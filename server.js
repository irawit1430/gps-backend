const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const prisma = new PrismaClient({ log: ['error'] });
const { execSync } = require('child_process');

try {
  console.log('Ensuring SQLite database is initialized...');
  execSync('npx prisma db push', { stdio: 'inherit' });
  execSync('node seed-admin.js', { stdio: 'inherit' });
  console.log('Database initialized successfully!');
} catch (e) {
  console.error('Failed to initialize database on boot:', e.message);
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('Fleet API is running perfectly!'));

// --- 0. AUTHENTICATION ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user.id, role: user.role, schoolId: user.schoolId }, process.env.JWT_SECRET || 'super-secret-fleet-key', { expiresIn: '7d' });
    
    const preferences = user.notificationSettings ? JSON.parse(user.notificationSettings) : {};
    res.json({ token, user: { id: user.id, role: user.role, name: user.name, email: user.email, schoolId: user.schoolId, preferences } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// --- 1. HARDWARE / SIMULATION ---
app.post('/api/telemetry', async (req, res) => {
  try {
    const { deviceId, lat, lng, speed, timestamp } = req.body;
    const bus = await prisma.bus.findUnique({ 
      where: { deviceId },
      include: { trips: { where: { status: "ON_SCHEDULE" }, include: { driver: { select: { name: true } }, route: { select: { name: true } } } } }
    });
    if (!bus) return res.status(404).json({ error: 'Bus not found' });

    const log = await prisma.gpsLog.create({
      data: { busId: bus.id, lat, lng, speed: speed || 0, timestamp: timestamp || new Date() }
    });

    // Push real-time event
    const activeTrip = bus.trips[0];
    io.emit('location_update', {
      busId: bus.id, 
      licensePlate: bus.licensePlate, 
      capacity: bus.capacity,
      driverName: activeTrip?.driver?.name || "Unassigned",
      routeName: activeTrip?.route?.name || "Off-Route",
      lat, lng, speed, timestamp: log.timestamp
    });
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 2. ADMIN DASHBOARD ---
// Buses
app.get('/api/schools/:schoolId/buses', async (req, res) => {
  try {
    const buses = await prisma.bus.findMany({
      where: { schoolId: req.params.schoolId },
      include: { 
        gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 },
        trips: { where: { status: { in: ["ON_SCHEDULE", "DELAYED"] } }, include: { driver: { select: { name: true } }, route: { select: { name: true } } } }
      } 
    });
    
    // Map response to surface active trip info directly for frontend convenience
    const formattedBuses = buses.map(bus => {
      const activeTrip = bus.trips[0];
      return {
        ...bus,
        driverName: activeTrip?.driver?.name || "Unassigned",
        routeName: activeTrip?.route?.name || "Off-Route"
      };
    });
    
    res.json(formattedBuses);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Leave Management
app.get('/api/schools/:schoolId/leaves', async (req, res) => {
  try {
    const { status } = req.query;
    let whereClause = { student: { schoolId: req.params.schoolId } };
    if (status && status !== 'all') {
      whereClause.status = status.toUpperCase();
    }
    
    const leaves = await prisma.leaveApplication.findMany({
      where: whereClause,
      include: { student: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json(leaves);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leaves/:id/approve', async (req, res) => {
  try {
    const leave = await prisma.leaveApplication.update({
      where: { id: req.params.id }, data: { status: "APPROVED" }
    });
    res.json(leave);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leaves/:id/reject', async (req, res) => {
  try {
    const leave = await prisma.leaveApplication.update({
      where: { id: req.params.id }, data: { status: "REJECTED" }
    });
    res.json(leave);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Route Management
app.get('/api/schools/:schoolId/routes', async (req, res) => {
  try {
    const routes = await prisma.route.findMany({
      where: { schoolId: req.params.schoolId },
      include: { stops: { orderBy: { orderIdx: 'asc' } }, trips: { take: 1, orderBy: { createdAt: 'desc' } } }
    });
    res.json(routes);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/schools/:schoolId/routes', async (req, res) => {
  try {
    const { name, estimatedDuration } = req.body;
    const route = await prisma.route.create({
      data: { schoolId: req.params.schoolId, name, estimatedDuration }
    });
    res.json(route);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/routes/:id', async (req, res) => {
  try {
    const route = await prisma.route.update({
      where: { id: req.params.id }, data: req.body
    });
    res.json(route);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/routes/:id', async (req, res) => {
  try {
    await prisma.route.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
// Drivers
app.get('/api/schools/:schoolId/drivers', async (req, res) => {
  try {
    const drivers = await prisma.user.findMany({
      where: { schoolId: req.params.schoolId, role: "DRIVER" },
      include: {
        driverTrips: {
          where: { status: { in: ["PLANNED", "ON_SCHEDULE"] } },
          include: { bus: true, route: true }
        }
      }
    });
    res.json(drivers);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/schools/:schoolId/drivers', async (req, res) => {
  try {
    const { name, email } = req.body;
    // For MVP, auto-generate a temporary password for the driver
    const tempPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    
    const driver = await prisma.user.create({
      data: {
        schoolId: req.params.schoolId,
        name,
        email,
        password: hashedPassword,
        role: "DRIVER"
      }
    });
    
    res.json({ driver, tempPassword });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Trips
app.post('/api/schools/:schoolId/trips', async (req, res) => {
  try {
    const { routeId, busId, driverId } = req.body;
    const trip = await prisma.trip.create({
      data: { routeId, busId, driverId, status: "PLANNED" }
    });
    res.json(trip);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Students & Attendance
app.get('/api/schools/:schoolId/students', async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where: { schoolId: req.params.schoolId },
      include: { routeMappings: { include: { routeStop: { include: { route: true } } } } }
    });
    res.json(students);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/schools/:schoolId/students', async (req, res) => {
  try {
    const { rfidTag, name, grade, parentEmail, parentName } = req.body;
    let parentId = null;
    let generatedPassword = null;

    // Auto-Invite Flow: Create parent if email is provided and doesn't exist
    if (parentEmail) {
      let parent = await prisma.user.findUnique({ where: { email: parentEmail } });
      
      if (!parent) {
        generatedPassword = Math.random().toString(36).slice(-8); // Generate random 8-char password
        const bcrypt = require('bcryptjs'); // Ensure bcrypt is available
        const hashedPassword = await bcrypt.hash(generatedPassword, 10);
        
        parent = await prisma.user.create({
          data: {
            email: parentEmail,
            password: hashedPassword,
            role: "PARENT",
            name: parentName || `Parent of ${name}`,
            schoolId: req.params.schoolId
          }
        });
      }
      parentId = parent.id;
    }

    const student = await prisma.student.create({
      data: { schoolId: req.params.schoolId, rfidTag, name, grade, parentId }
    });

    res.json({
      student,
      parentCredentials: generatedPassword ? { email: parentEmail, temporaryPassword: generatedPassword } : null
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/schools/:schoolId/attendance/today', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const logs = await prisma.attendanceLog.findMany({
      where: { student: { schoolId: req.params.schoolId }, timestamp: { gte: today } },
      include: { student: true, trip: { include: { route: true } } }
    });
    res.json(logs);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// School Dashboard Metrics
app.get('/api/schools/:schoolId/stats', async (req, res) => {
  try {
    const schoolId = req.params.schoolId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const totalStudents = await prisma.student.count({ where: { schoolId } });
    const totalRoutes = await prisma.route.count({ where: { schoolId } });
    const activeTrips = await prisma.trip.count({ where: { route: { schoolId }, status: "ON_SCHEDULE" } });
    const totalBoarded = await prisma.attendanceLog.count({ where: { student: { schoolId }, type: "BOARDED", timestamp: { gte: today } } });
    const pendingLeaves = await prisma.leaveApplication.count({ where: { student: { schoolId }, status: "PENDING" } });

    res.json({ totalStudents, totalRoutes, activeTrips, totalBoarded, pendingLeaves });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// --- 3. PARENT APP ---
app.patch('/api/parents/:id/preferences', async (req, res) => {
  try {
    const preferences = JSON.stringify(req.body);
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { notificationSettings: preferences }
    });
    res.json({ preferences: JSON.parse(user.notificationSettings) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/parents/:parentId/students', async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where: { parentId: req.params.parentId },
      include: { 
        routeMappings: { 
          include: { 
            routeStop: {
              include: {
                route: {
                  include: {
                    trips: {
                      where: { status: { in: ["ON_SCHEDULE", "DELAYED"] } },
                      include: {
                        driver: { select: { name: true } },
                        bus: { select: { licensePlate: true, deviceId: true } }
                      }
                    }
                  }
                }
              }
            } 
          } 
        } 
      }
    });
    
    // Format the response to pull the active trip/driver up for the frontend
    const formattedStudents = students.map(student => {
      const activeTrip = student.routeMappings[0]?.routeStop?.route?.trips[0] || null;
      return {
        id: student.id,
        name: student.name,
        grade: student.grade,
        photoUrl: student.photoUrl,
        routeStopName: student.routeMappings[0]?.routeStop?.name || "Unassigned",
        driverName: activeTrip?.driver?.name || "Unassigned",
        licensePlate: activeTrip?.bus?.licensePlate || "Unassigned"
      };
    });
    
    res.json(formattedStudents);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leaves', async (req, res) => {
  try {
    const { studentId, startDate, endDate, reason, notes } = req.body;
    const leave = await prisma.leaveApplication.create({
      data: { studentId, startDate: new Date(startDate), endDate: new Date(endDate), reason, notes, status: "PENDING" }
    });
    res.json(leave);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/parents/:parentId/leaves', async (req, res) => {
  try {
    const leaves = await prisma.leaveApplication.findMany({
      where: { student: { parentId: req.params.parentId } },
      include: { student: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json(leaves);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/parents/:parentId/notifications', async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.params.parentId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    res.json(notifications);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// --- 4. DRIVER APP ---
app.post('/api/alerts/sos', async (req, res) => {
  try {
    const { schoolId, senderId, message, tripId } = req.body;
    const alert = await prisma.emergencyAlert.create({
      data: { schoolId, senderId, type: "DRIVER_SOS", message, tripId, status: "ACTIVE" }
    });
    // Instantly notify admin dashboard
    io.emit('emergency_alert', alert);
    res.json(alert);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/drivers/:driverId/trips', async (req, res) => {
  try {
    const trips = await prisma.trip.findMany({
      where: { driverId: req.params.driverId, status: { in: ["PLANNED", "ON_SCHEDULE", "DELAYED"] } },
      include: {
        route: {
          include: {
            stops: {
              orderBy: { orderIdx: 'asc' },
              include: { studentMappings: { include: { student: true } } }
            }
          }
        },
        bus: true
      },
      orderBy: { createdAt: 'asc' }
    });
    res.json(trips);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/trips/:tripId/status', async (req, res) => {
  try {
    const { status } = req.body;
    const data = { status };
    if (status === "ON_SCHEDULE") data.startTime = new Date();
    if (status === "COMPLETED") data.endTime = new Date();

    const trip = await prisma.trip.update({
      where: { id: req.params.tripId },
      data
    });
    res.json(trip);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attendance', async (req, res) => {
  try {
    const { studentId, tripId, type } = req.body;
    const log = await prisma.attendanceLog.create({
      data: { studentId, tripId, type }
    });
    res.json(log);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// --- 5. SUPER ADMIN STATS ---
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalSchools = await prisma.school.count();
    const totalBuses = await prisma.bus.count();
    const totalStudents = await prisma.student.count();
    
    // For offline devices, we return a placeholder until hardware heartbeats are implemented in schema
    const offlineDevices = 18; // Placeholder matching your UI

    res.json({
      totalSchools,
      totalBuses,
      offlineDevices,
      totalStudents
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// --- 6. SUPER ADMIN DATA ---
// School Management
app.get('/api/schools', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    
    const where = search ? { name: { contains: search } } : {};
    
    const [schools, total] = await Promise.all([
      prisma.school.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.school.count({ where })
    ]);
    
    res.json({ data: schools, total, page, limit });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/schools', async (req, res) => {
  try {
    const { name, address } = req.body;
    const school = await prisma.school.create({ data: { name, address } });
    res.json(school);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/schools/:id', async (req, res) => {
  try {
    const school = await prisma.school.update({
      where: { id: req.params.id }, data: req.body
    });
    res.json(school);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/schools/:id', async (req, res) => {
  try {
    // Delete related entities first due to foreign keys, or rely on Prisma cascade if configured.
    // Assuming simple delete for now, if it fails, cascading needs to be explicitly handled.
    await prisma.school.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: "Cannot delete school with active associations. Please remove devices and routes first." }); }
});

// Device Provisioning
app.get('/api/devices', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';
    
    const where = search ? {
      OR: [
        { licensePlate: { contains: search } },
        { deviceId: { contains: search } }
      ]
    } : {};

    const [devices, total] = await Promise.all([
      prisma.bus.findMany({
        where,
        include: { school: { select: { name: true } } },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { licensePlate: 'asc' }
      }),
      prisma.bus.count({ where })
    ]);
    
    res.json({ data: devices, total, page, limit });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/devices', async (req, res) => {
  try {
    const { deviceId, licensePlate, capacity, schoolId } = req.body;
    // Note: schoolId is now optional, so it can be unassigned (null)
    const device = await prisma.bus.create({
      data: { deviceId, licensePlate, capacity: capacity || 40, schoolId: schoolId || null }
    });
    io.emit('device_status_change', { deviceId: device.id, status: 'ONLINE', message: 'New device provisioned' });
    res.json(device);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/devices/:id', async (req, res) => {
  try {
    const device = await prisma.bus.update({
      where: { id: req.params.id }, data: req.body
    });
    io.emit('device_status_change', { deviceId: device.id, status: 'ONLINE', message: 'Device updated' });
    res.json(device);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/devices/:id', async (req, res) => {
  try {
    await prisma.bus.delete({ where: { id: req.params.id } });
    io.emit('device_status_change', { deviceId: req.params.id, status: 'OFFLINE', message: 'Device decommissioned' });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Initial Map State & Real-time Status
app.get('/api/devices/locations', async (req, res) => {
  try {
    // Get the most recent GPS log for all buses
    const buses = await prisma.bus.findMany({
      include: { 
        gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 },
        school: { select: { name: true } }
      }
    });
    // Flatten the response for the map markers
    const locations = buses.map(bus => ({
      busId: bus.id,
      licensePlate: bus.licensePlate,
      schoolName: bus.school?.name || "Unassigned",
      lastKnownLat: bus.gpsLogs[0]?.lat || null,
      lastKnownLng: bus.gpsLogs[0]?.lng || null,
      speed: bus.gpsLogs[0]?.speed || 0,
      lastUpdate: bus.gpsLogs[0]?.timestamp || null
    })).filter(b => b.lastKnownLat !== null);

    res.json(locations);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Advanced System Logs
app.get('/api/admin/logs', async (req, res) => {
  try {
    const { busId, schoolId, startDate } = req.query;
    
    // Build filter
    let where = {};
    if (busId) where.busId = busId;
    if (schoolId) where.bus = { schoolId };
    if (startDate) where.timestamp = { gte: new Date(startDate) };
    
    // Fetch logs (limit 100 for performance)
    const logs = await prisma.gpsLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: 100,
      include: { bus: { select: { licensePlate: true } } }
    });
    
    res.json(logs);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admins Management
app.get('/api/admins', async (req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: { in: ['SUPER_ADMIN', 'SCHOOL_ADMIN'] } },
      select: { id: true, name: true, email: true, role: true, schoolId: true, createdAt: true }
    });
    res.json(admins);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admins', async (req, res) => {
  try {
    const { name, email, password, role, schoolId } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const admin = await prisma.user.create({
      data: { name, email, password: hashedPassword, role, schoolId },
      select: { id: true, name: true, email: true, role: true }
    });
    res.json(admin);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admins/:id', async (req, res) => {
  try {
    const { password, ...updateData } = req.body;
    if (password) updateData.password = await bcrypt.hash(password, 10);
    
    const admin = await prisma.user.update({
      where: { id: req.params.id }, 
      data: updateData,
      select: { id: true, name: true, email: true, role: true }
    });
    res.json(admin);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admins/:id', async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Settings Management
app.get('/api/settings', async (req, res) => {
  try {
    let settings = await prisma.globalSettings.findUnique({ where: { id: "global" } });
    if (!settings) {
      settings = await prisma.globalSettings.create({ data: { id: "global" } });
    }
    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/settings', async (req, res) => {
  try {
    const settings = await prisma.globalSettings.upsert({
      where: { id: "global" },
      update: req.body,
      create: { id: "global", ...req.body }
    });
    res.json(settings);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

io.on('connection', (socket) => {
  console.log('New Client Connected:', socket.id);
});

server.listen(3000, () => console.log('Server running on port 3000'));
