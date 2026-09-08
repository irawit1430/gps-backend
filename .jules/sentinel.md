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
## 2025-02-23 - Insecure Direct Object Reference (IDOR) on School Routes
**Vulnerability:** School-related endpoints (`/api/schools/:schoolId/*`) lacked explicit authorization checks to verify if the authenticated user belongs to the requested school. This allowed any authenticated user (e.g. an ADMIN from another school or even a PARENT) to view and manipulate resources (buses, drivers, students, routes) belonging to other schools by modifying the `schoolId` parameter in the request URL.
**Learning:** The global `authenticate` middleware only verifies the presence of a valid token. Furthermore, role-based authorization (e.g., verifying a user is a `SCHOOL_ADMIN`) does not inherently restrict access to only the resources belonging to their specific school. Authentication does not imply resource ownership.
**Prevention:** Always implement explicit, resource-level authorization checks (e.g., using a custom `authorizeSchoolResource` middleware applied via `app.use('/api/schools/:schoolId', authorizeSchoolResource)`) to verify that the authenticated user's `schoolId` matches the requested resource ID, unless they possess global privileges (like `SUPER_ADMIN`).
