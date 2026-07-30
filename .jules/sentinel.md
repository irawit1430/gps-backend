## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.
## 2025-01-20 - Missing Authorization Checks on Admin Endpoints
**Vulnerability:** Critical admin endpoints like `/api/admin/stats`, `/api/admins`, and `/api/settings` lacked authorization checks, allowing any authenticated user to perform sensitive actions.
**Learning:** Authentication (validating a user's identity) is distinct from authorization (validating a user's permissions). Even if an endpoint uses the `authenticate` middleware, it still needs explicit role-based validation to restrict access correctly.
**Prevention:** Always implement an `authorizeRoles(...roles)` middleware or similar check for any endpoint that exposes sensitive administrative operations or data, ensuring that only users with the correct roles can execute those operations.
