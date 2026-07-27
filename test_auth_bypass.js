const { app } = require('./server.js');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const token = jwt.sign({ id: 99, role: 'PARENT', schoolId: 1 }, process.env.JWT_SECRET || 'super-secret-fleet-key');

async function runTest() {
  const res = await request(app)
    .get('/api/admin/stats')
    .set('Authorization', `Bearer ${token}`);

  console.log('Status code for PARENT on /api/admin/stats:', res.status);
  process.exit(0);
}

runTest();
