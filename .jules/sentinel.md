## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.
## 2025-02-23 - Missing Role-Based Access Control (RBAC) on Admin Endpoints
**Vulnerability:** Admin endpoints (`/api/admin/*`) were accessible to any authenticated user (e.g., `PARENT` or `DRIVER`), lacking proper authorization checks to restrict access.
**Learning:** Authentication (verifying identity) does not automatically provide Authorization (verifying permissions). Admin routes need explicit role verification.
**Prevention:** Always implement and enforce an `authorizeRoles` middleware to restrict sensitive routes based on `req.user.role`.
