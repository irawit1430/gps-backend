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
**Vulnerability:** Parent-related endpoints (`/api/parents/:id/preferences`, `/api/parents/:parentId/*`) lacked explicit authorization checks to verify if the authenticated user owns the requested resource, allowing users to potentially access or modify data belonging to other parents.
**Learning:** The global `authenticate` middleware only verifies token presence; it does not ensure resource ownership. Without explicit IDOR protection, authenticated users can access resources they shouldn't by modifying the resource ID in the request.
**Prevention:** Always implement explicit authorization checks (e.g., using a custom `authorizeParentResource` middleware) for endpoints that access resources belonging to a specific user to prevent IDOR.
## 2025-02-23 - Authorization Bypass via Missing 'else if' in Route Handlers
**Vulnerability:** Several route handlers (`/api/admin/stats`, `/api/search`, `/api/notifications`) used a "fail-open" conditional structure. They checked `if (role === 'SCHOOL_ADMIN')` and then used a catch-all `else` block to execute highly privileged `SUPER_ADMIN` logic. If a user had an invalid, unexpected, or lower-privileged role that fell through the initial `if`, they were mistakenly granted `SUPER_ADMIN` access to global stats, search, and system notifications.
**Learning:** Catch-all `else` blocks should never be used to grant elevated privileges. When routing logic relies on roles, every authorized role must be explicitly checked (e.g., `else if (role === 'SUPER_ADMIN')`).
**Prevention:** Always use explicit conditional checks for privileged operations. The final `else` block in an authorization chain must strictly deny access (e.g., returning a `403 Forbidden` response) to enforce a "fail-closed" security posture.
