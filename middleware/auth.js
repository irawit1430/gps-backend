const jwt = require('jsonwebtoken');
const config = require('../config');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid token' });
  }
  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, config.JWT_SECRET);
    return next();
  } catch (err) {
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

module.exports = { authenticate, authorizeRoles, requireTenant, requireSelfOrRoles };
