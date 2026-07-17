const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const middlewareCode = `
// Authentication Middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' || req.path === '/telemetry') return next();
  return authenticate(req, res, next);
});

`;

// Insert after app.use(express.json());
code = code.replace("app.use(express.json());", "app.use(express.json());\n" + middlewareCode);

fs.writeFileSync('server.js', code);
