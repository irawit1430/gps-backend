## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.

## 2024-05-20 - Hardcoded Passwords in Ephemeral Databases
**Vulnerability:** Found `password123` hardcoded in `seed-admin.js` for all initial dummy users (Super Admin, Principal, Driver, Parent).
**Learning:** Because the project uses an ephemeral database (Render + SQLite), the DB is dropped on sleep and recreated on wake via the startup script (`npx prisma db push && node seed-admin.js && node server.js`). This means these users are generated dynamically in production and would have their passwords persistently set to a widely known insecure hardcoded string.
**Prevention:** Avoid hardcoded credentials in seed scripts that run in production. Always inject credentials securely via environment variables (like `ADMIN_PASSWORD`), falling back to a cryptographically secure random string (e.g., `crypto.randomBytes()`) for test deployments, and log it so admins can log in.
