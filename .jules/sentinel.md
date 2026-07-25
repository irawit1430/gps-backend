## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.
## 2024-07-25 - Lack of RBAC on Admin Endpoints
**Vulnerability:** System monitoring endpoints like `/api/admin/stats` and `/api/admin/logs` were lacking role-based access control (RBAC). Any authenticated user (e.g. `PARENT` or `DRIVER`) could fetch complete system stats and view all advanced tracking logs, exposing cross-tenant sensitive info.
**Learning:** The project relied purely on standard authentication (`authenticate` middleware) instead of granularly securing sensitive API routes against non-admin roles, resulting in an Insecure Direct Object Reference / Broken Access Control issue.
**Prevention:** Implement and attach an `authorizeRoles` middleware factory (e.g., `authorizeRoles('SUPER_ADMIN')`) before executing endpoint logic on any route granting sweeping system views or admin management access. Ensure tests explicitly verify access control barriers for unauthorized roles.
