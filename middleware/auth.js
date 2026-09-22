const jwt = require('jsonwebtoken');
const config = require('../config');

// Revocation state, checked on every request and socket connection.
//
//  - tokenDenylist: exact tokens revoked on explicit logout (self only). In memory
//    only, so a restart forgets it; the app deletes its copy of the token on logout.
//  - userInvalidatedAt: userId → unix-seconds cutoff. Any token for that user whose
//    `iat` (issued-at) is at or before the cutoff is rejected. Used to revoke a user's
//    *existing* tokens when they are deleted or their role/school/password changes —
//    cases where we do not hold the actual token string. Each cutoff is also handed to
//    onUserRevoked listeners, which save it (User.tokensValidAfter, see
//    sessionRevocations.js) so the next process can restoreRevocations() at boot.
//    Without that, a restart revived every such token until it expired.
//
// One process only: a second instance would not see the first one's revocations until
// it restarted.
const tokenDenylist = new Set();
const userInvalidatedAt = new Map();
const invalidationListeners = new Set();
const revocationListeners = new Set();

function notifyInvalidation(userId) {
  if (!userId) return;
  for (const listener of invalidationListeners) listener(userId);
}

function onUserInvalidated(listener) {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

function logoutToken(token) {
  if (!token) return;
  tokenDenylist.add(token);
  notifyInvalidation(jwt.decode(token)?.id);
}

// Called with (userId, cutoffSeconds) each time invalidateUser ends all of a user's
// sessions. Not called for a single logout, which ends only the one token.
function onUserRevoked(listener) {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
}

// Revoke every token issued to a user up to now (delete / role / school / password change).
function invalidateUser(userId) {
  if (!userId) return;
  const cutoff = Math.floor(Date.now() / 1000);
  userInvalidatedAt.set(userId, cutoff);
  for (const listener of revocationListeners) listener(userId, cutoff);
  notifyInvalidation(userId);
}

// Put back cutoffs saved by an earlier process: [userId, unixSeconds] pairs. A cutoff
// only ever moves later, so restoring can never revive a token revoked since boot.
function restoreRevocations(entries) {
  for (const [userId, cutoff] of entries) {
    if (!userId || !Number.isFinite(cutoff)) continue;
    if (cutoff > (userInvalidatedAt.get(userId) || 0)) userInvalidatedAt.set(userId, cutoff);
  }
}

function verifyAccessToken(token) {
  if (tokenDenylist.has(token)) {
    const err = new Error('Token has been revoked');
    err.code = 'TOKEN_REVOKED';
    throw err;
  }
  const user = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  const cutoff = userInvalidatedAt.get(user.id);
  if (cutoff && typeof user.iat === 'number' && user.iat <= cutoff) {
    const err = new Error('Token has been revoked');
    err.code = 'TOKEN_REVOKED';
    throw err;
  }
  return user;
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid token' });
  }
  const token = authHeader.slice(7);
  try {
    req.user = verifyAccessToken(token);
    req.token = token;
    return next();
  } catch (err) {
    if (err.code === 'TOKEN_REVOKED') {
      return res.status(401).json({ error: 'Unauthorized: token has been revoked' });
    }
    return res.status(401).json({ error: 'Unauthorized: invalid token' });
  }
}

function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

// requireTenant('schoolId') ensures the URL param matches the caller's tenant.
// SUPER_ADMIN bypasses.
function requireTenant(paramName = 'schoolId') {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.user.role === 'SUPER_ADMIN') return next();
    const target = req.params[paramName];
    if (!target) return res.status(400).json({ error: `Missing ${paramName} param` });
    if (req.user.schoolId !== target) {
      return res.status(403).json({ error: 'Forbidden: cross-tenant access denied' });
    }
    next();
  };
}

// requireSelfOrRoles('parentId', 'SUPER_ADMIN', 'SCHOOL_ADMIN'):
// allow if req.user.id === req.params[paramName], or role is in allowlist.
function requireSelfOrRoles(paramName, ...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (allowedRoles.includes(req.user.role)) return next();
    if (req.user.id === req.params[paramName]) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}

// A parent still on the password they were provisioned with.
//
// That password can be one shared by a whole school (PARENT_DEFAULT_PASSWORD), so an
// account nobody has claimed yet opens for anyone who has the notice and can guess an
// email — and every parent account can see a child's live position. mustResetPassword
// used to be advisory: login reported it, nothing enforced it, and an unchanged account
// stayed fully usable. Login now carries it in the token for parents, and until the
// password changes that token can do nothing but change it (or log out).
//
// Parents only: they are the accounts a shared password opens, and the parent app
// already routes a forced reset. Drivers and admins get individual passwords, and the
// super-admin dashboard has no reset flow to route them to.
function passwordResetPending(user) {
  return user?.role === 'PARENT' && user?.mustResetPassword === true;
}

function requireCurrentPassword(req, res, next) {
  if (passwordResetPending(req.user)) {
    return res.status(403).json({
      error: 'Change your password to continue',
      code: 'PASSWORD_RESET_REQUIRED',
    });
  }
  next();
}

module.exports = {
  passwordResetPending,
  requireCurrentPassword,
  authenticate,
  authorizeRoles,
  requireTenant,
  requireSelfOrRoles,
  logoutToken,
  invalidateUser,
  verifyAccessToken,
  onUserInvalidated,
  onUserRevoked,
  restoreRevocations,
};
