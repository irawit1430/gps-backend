const logger = require('../logger');
const { verifyAccessToken, onUserInvalidated } = require('./auth');

// Socket.IO authentication middleware.
// Clients pass their JWT in handshake auth: io({ auth: { token: '...' } }). Query
// strings are deliberately unsupported because URLs are commonly retained in proxy,
// browser, and monitoring logs.
//
// On success:
//   - socket.data.user = decoded payload (id, role, schoolId)
//   - Auto-joins admins to `school-admin:${schoolId}` for privileged tenant emits
//   - SUPER_ADMIN also joins `super:all` (catches every event)
function attachSocketAuth(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Unauthorized: missing token'));
    try {
      const user = verifyAccessToken(token);
      socket.data.user = user;
      socket.join(`user:${user.id}`);
      if (user.role === 'SCHOOL_ADMIN' && user.schoolId) {
        socket.join(`school-admin:${user.schoolId}`);
      }
      if (user.role === 'SUPER_ADMIN') socket.join('super:all');
      next();
    } catch (err) {
      next(new Error(err.code === 'TOKEN_REVOKED' ? 'Unauthorized: token has been revoked' : 'Unauthorized: invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    logger.info({ userId: u.id, role: u.role, schoolId: u.schoolId, sid: socket.id }, 'socket connected');
    socket.on('disconnect', (reason) => {
      logger.debug({ sid: socket.id, reason }, 'socket disconnected');
    });
  });

  // Password/role changes and HTTP logout terminate already-connected sockets too;
  // otherwise a revoked bearer token could keep receiving realtime data until the
  // transport happened to reconnect.
  onUserInvalidated((userId) => {
    io.in?.(`user:${userId}`).disconnectSockets(true);
  });
}

// Emit a privileged event scoped to one school's admins + super admins.
// If schoolId is null/undefined we fall back to super:all only.
function emitToSchool(io, schoolId, event, payload) {
  // One emit across both rooms — Socket.IO delivers a single copy to a socket that
  // is in both (a SUPER_ADMIN who also carries a schoolId). Emitting per room would
  // deliver the event twice to that admin.
  const target = schoolId ? io.to(`school-admin:${schoolId}`).to('super:all') : io.to('super:all');
  target.emit(event, payload);
}

function emitToUser(io, userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}

// Emit one event to a set of individual users. Socket.IO delivers a single copy to a
// socket that matches more than one of the rooms, so a parent with two children on
// the same trip receives it once rather than twice.
function emitToUsers(io, userIds, event, payload) {
  if (!io || !userIds || userIds.length === 0) return;
  io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
}

module.exports = { attachSocketAuth, emitToSchool, emitToUser, emitToUsers };
