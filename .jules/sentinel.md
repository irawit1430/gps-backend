## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.
## 2025-02-09 - Missing Authorization on Admin Endpoints
**Vulnerability:** The endpoints `/api/admin` and `/api/admins` were unprotected by role-based authorization checks, meaning any authenticated user could access them and potentially escalate privileges.
**Learning:** Adding the authentication middleware alone ensures that the user is logged in, but it doesn't verify the user's role/permissions. This is an authorization bypass.
**Prevention:** Always implement explicit role checks on sensitive endpoints (e.g., using `authorizeRoles('SUPER_ADMIN')` middleware) rather than just relying on generic authentication.
