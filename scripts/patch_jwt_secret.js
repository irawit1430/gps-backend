const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Insert JWT_SECRET check
const jwtCheckCode = `
if (!process.env.JWT_SECRET) {
  console.error('FATAL: process.env.JWT_SECRET is required');
  process.exit(1);
}

// --- 0. AUTHENTICATION ---`;

code = code.replace("// --- 0. AUTHENTICATION ---", jwtCheckCode);

// Remove hardcoded fallback
code = code.replace("process.env.JWT_SECRET || 'super-secret-fleet-key'", "process.env.JWT_SECRET");

fs.writeFileSync('server.js', code);
