const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../logger');

// Socket.IO authentication middleware.
// Clients pass their JWT in handshake auth: io({ auth: { token: '...' } })
// or via ?token=... query fallback.
//
// On success:
//   - socket.data.user = decoded payload (id, role, schoolId)
//   - Auto-joins socket to `school:${schoolId}` for tenant-scoped emits
//   - SUPER_ADMIN also joins `super:all` (catches every event)
function attachSocketAuth(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Unauthorized: missing token'));
    try {
      const user = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
      socket.data.user = user;
      if (user.schoolId) socket.join(`school:${user.schoolId}`);
      if (user.role === 'SUPER_ADMIN') socket.join('super:all');
      if (user.role === 'PARENT') socket.join(`user:${user.id}`);
      if (user.role === 'DRIVER') socket.join(`user:${user.id}`);
      next();
    } catch (err) {
      next(new Error('Unauthorized: invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    logger.info({ userId: u.id, role: u.role, schoolId: u.schoolId, sid: socket.id }, 'socket connected');
    socket.on('disconnect', (reason) => {
      logger.debug({ sid: socket.id, reason }, 'socket disconnected');
    });
  });
}

// Emit an event scoped to a school + super admins.
// If schoolId is null/undefined we fall back to super:all only.
function emitToSchool(io, schoolId, event, payload) {
  // One emit across both rooms — Socket.IO delivers a single copy to a socket that
  // is in both (a SUPER_ADMIN who also carries a schoolId). Emitting per room would
  // deliver the event twice to that admin.
  const target = schoolId ? io.to(`school:${schoolId}`).to('super:all') : io.to('super:all');
  target.emit(event, payload);
}

function emitToUser(io, userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}

module.exports = { attachSocketAuth, emitToSchool, emitToUser };
