const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. /api/routes/:id
code = code.replace(
  `app.put('/api/routes/:id', async (req, res) => {
  try {
    const route = await prisma.route.update({
      where: { id: req.params.id }, data: req.body
    });`,
  `app.put('/api/routes/:id', async (req, res) => {
  try {
    const { name, estimatedDuration } = req.body;
    const route = await prisma.route.update({
      where: { id: req.params.id }, data: { name, estimatedDuration }
    });`
);

// 2. /api/schools/:id
code = code.replace(
  `app.put('/api/schools/:id', async (req, res) => {
  try {
    const school = await prisma.school.update({
      where: { id: req.params.id }, data: req.body
    });`,
  `app.put('/api/schools/:id', async (req, res) => {
  try {
    const { name, address } = req.body;
    const school = await prisma.school.update({
      where: { id: req.params.id }, data: { name, address }
    });`
);

// 3. /api/devices/:id
code = code.replace(
  `app.put('/api/devices/:id', async (req, res) => {
  try {
    const device = await prisma.bus.update({
      where: { id: req.params.id }, data: req.body
    });`,
  `app.put('/api/devices/:id', async (req, res) => {
  try {
    const { deviceId, licensePlate, capacity, schoolId } = req.body;
    const device = await prisma.bus.update({
      where: { id: req.params.id }, data: { deviceId, licensePlate, capacity, schoolId }
    });`
);

// 4. /api/admins/:id
code = code.replace(
  `app.put('/api/admins/:id', async (req, res) => {
  try {
    const { password, ...updateData } = req.body;
    if (password) updateData.password = await bcrypt.hash(password, 10);

    const admin = await prisma.user.update({
      where: { id: req.params.id },
      data: updateData,
      select: { id: true, name: true, email: true, role: true }
    });`,
  `app.put('/api/admins/:id', async (req, res) => {
  try {
    const updateData = {
      name: req.body.name,
      email: req.body.email,
      role: req.body.role,
      schoolId: req.body.schoolId
    };
    if (req.body.password) {
      updateData.password = await bcrypt.hash(req.body.password, 10);
    }

    const admin = await prisma.user.update({
      where: { id: req.params.id },
      data: updateData,
      select: { id: true, name: true, email: true, role: true }
    });`
);

// 5. /api/settings
code = code.replace(
  `app.put('/api/settings', async (req, res) => {
  try {
    const settings = await prisma.globalSettings.upsert({
      where: { id: "global" },
      update: req.body,
      create: { id: "global", ...req.body }
    });`,
  `app.put('/api/settings', async (req, res) => {
  try {
    const { maintenanceMode, mapCenterLat, mapCenterLng } = req.body;
    const settingsData = { maintenanceMode, mapCenterLat, mapCenterLng };
    const settings = await prisma.globalSettings.upsert({
      where: { id: "global" },
      update: settingsData,
      create: { id: "global", ...settingsData }
    });`
);

fs.writeFileSync('server.js', code);
