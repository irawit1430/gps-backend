## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.
## 2025-02-23 - Missing Role-Based Access Control (RBAC) on Admin Routes
**Vulnerability:** Critical admin-level routes (like `/api/admins`, `/api/admin/stats`, `/api/settings`) were missing `authorizeRoles` middleware checks, allowing any authenticated user to access them and potentially escalate privileges.
**Learning:** Even though `authenticate` middleware was in place, it only verified the presence of a valid token without checking the user's role. Authentication does not imply authorization. The assumption that the middleware already restricted access was incorrect.
**Prevention:** Always verify that sensitive endpoints have explicit role-based access checks (e.g., `authorizeRoles('SUPER_ADMIN')`) applied at the route definition or using an `app.use` prefix. Never assume authentication implies authorization.
## 2025-02-23 - Insecure Random Number Generation for RFID
**Vulnerability:** The `rfidTag` for students was being generated using `Math.random()`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG).
**Prevention:** Use `crypto.randomInt()` from Node.js's native `crypto` module to generate random values for RFIDs.

## 2025-02-23 - Missing Rate Limiting on Login Endpoint
**Vulnerability:** The login endpoint (`/api/auth/login`) lacked rate limiting.
**Learning:** This leaves the endpoint vulnerable to brute-force attacks.
**Prevention:** Use `express-rate-limit` to limit requests to authentication endpoints.
## 2025-02-23 - Insecure Direct Object Reference (IDOR) on Parent Routes
**Vulnerability:** Parent endpoints (`/api/parents/:id/*` and `/api/parents/:parentId/*`) lacked authorization checks, allowing authenticated users to access and modify data belonging to other users.
**Learning:** Global authentication middleware (`authenticate`) ensures a user is logged in, but it does not ensure they own the resource they are requesting. Authorization must be explicitly handled.
**Prevention:** Always verify `req.user.id` against resource owner IDs (like route parameters) for sensitive user-specific endpoints, typically via a custom authorization middleware or inline checks.
