## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.
## 2025-01-20 - Missing Function Level Access Control on Admin Endpoints
**Vulnerability:** Several administrative endpoints (like `/api/admin/stats`, `/api/admins`, and `/api/admin/logs`) were protected by basic authentication but lacked authorization checks (role validation). This allowed any authenticated user, such as a parent or driver, to access these endpoints, leading to Broken Access Control.
**Learning:** The implementation of role-based access control (RBAC) was documented in memory but absent from the actual route definitions. Relying solely on `authenticate` middleware is insufficient for privileged operations.
**Prevention:** Ensure that all endpoints meant for specific roles explicitly utilize the `authorizeRoles(...roles)` middleware to validate `req.user.role` before allowing the request to proceed.
