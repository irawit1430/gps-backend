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
    
    res.json({ token, user: { id: user.id, role: user.role, name: user.name, email: user.email, schoolId: user.schoolId } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  jwt.verify(token, process.env.JWT_SECRET || 'super-secret-fleet-key', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// --- 1. HARDWARE / SIMULATION ---
const crypto = require('crypto');

app.post('/api/telemetry', async (req, res) => {
  const providedApiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.TELEMETRY_API_KEY;

  if (!providedApiKey || !expectedApiKey) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  const expectedBuffer = Buffer.from(expectedApiKey);
  const providedBuffer = Buffer.from(providedApiKey);

  // Use timingSafeEqual to prevent timing attacks, and check length first to prevent error
  if (expectedBuffer.length !== providedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  try {
    const { deviceId, lat, lng, speed, timestamp } = req.body;
    const bus = await prisma.bus.findUnique({ where: { deviceId } });
    if (!bus) return res.status(404).json({ error: 'Bus not found' });

    const log = await prisma.gpsLog.create({
      data: { busId: bus.id, lat, lng, speed: speed || 0, timestamp: timestamp || new Date() }
    });

    // Push real-time event
    io.emit('location_update', {
      busId: bus.id, licensePlate: bus.licensePlate, lat, lng, speed, timestamp: log.timestamp
    });
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 2. ADMIN DASHBOARD ---
app.get('/api/schools/:schoolId/buses', async (req, res) => {
  try {
    const buses = await prisma.bus.findMany({
      where: { schoolId: req.params.schoolId },
      include: { gpsLogs: { orderBy: { timestamp: 'desc' }, take: 1 } } // Gets latest live location
    });
    res.json(buses);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/schools/:schoolId/leaves/pending', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'SUPER_ADMIN' && req.user.schoolId !== req.params.schoolId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const leaves = await prisma.leaveApplication.findMany({
      where: { student: { schoolId: req.params.schoolId }, status: "PENDING" },
      include: { student: true }
    });
    res.json(leaves);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// --- 3. PARENT APP ---
app.get('/api/parents/:parentId/students', async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where: { parentId: req.params.parentId },
      include: { routeMappings: { include: { routeStop: true } } }
    });
    res.json(students);
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
app.get('/api/schools', async (req, res) => {
  try {
    const schools = await prisma.school.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(schools);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/schools', async (req, res) => {
  try {
    const { name, address } = req.body;
    const school = await prisma.school.create({ data: { name, address } });
    res.json(school);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/devices', async (req, res) => {
  try {
    // In our schema, TM-100 devices are attached to Buses
    const devices = await prisma.bus.findMany({
      include: { school: { select: { name: true } } },
      orderBy: { licensePlate: 'asc' }
    });
    res.json(devices);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

io.on('connection', (socket) => {
  console.log('New Client Connected:', socket.id);
});

server.listen(3000, () => console.log('Server running on port 3000'));
