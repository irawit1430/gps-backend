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
## 2025-02-23 - Authorization Bypass on Device Provisioning Routes
**Vulnerability:** The `/api/devices` endpoints (POST, PUT, DELETE) were entirely missing `authorizeRoles` checks. This allowed any authenticated user (e.g., PARENT) to provision or decommission hardware devices, bypassing intended administrative controls.
**Learning:** Endpoints meant for administrative provisioning may be inadvertently left exposed if role-based middleware isn't applied systematically. Global authentication middleware does not suffice for role-based actions.
**Prevention:** Always verify that critical provisioning and management endpoints have `authorizeRoles('SUPER_ADMIN')` or equivalent checks directly on the route or via a router prefix.
