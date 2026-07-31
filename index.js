// Render by default sometimes looks for index.js
// Forwarding the execution to our actual main server file
require('dotenv').config();
const { execSync } = require('child_process');

try {
  console.log('Ensuring SQLite database is initialized from index.js...');
  execSync('npx prisma db push --accept-data-loss --skip-generate', { stdio: 'inherit' });
  execSync('node seed-admin.js', { stdio: 'inherit' });
  console.log('Database initialized successfully!');
} catch (e) {
  console.error('Failed to initialize database on boot:', e.message);
}

const { server, io } = require('./server.js');
const { startTcpServer } = require('./tcp-server.js');

const PORT = process.env.PORT || 3000;
const TCP_PORT = process.env.TCP_PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  try {
    startTcpServer(io, TCP_PORT);
  } catch (err) {
    console.error('Failed to start TCP listener:', err.message);
  }
});

