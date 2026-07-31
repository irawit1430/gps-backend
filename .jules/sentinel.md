## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.
## 2026-07-31 - Fix Authentication Middleware Bypass
**Vulnerability:** The authentication middleware was mounted at `/api` using `app.use('/api', ...)`. By leveraging routing quirks such as requesting `/API/admin` or using URL-encoded path traversal techniques, the mount path could potentially be bypassed while still hitting intended route handlers due to case-insensitivity or double slashes.
**Learning:** Mounting middleware using `app.use('/prefix')` can create edge cases where the path matching behavior differs slightly from `app.get('/prefix/...')`. Additionally, it relied on an overly narrow string matching strategy.
**Prevention:** Apply security middleware globally using `app.use((req, res, next) => ...)` and validate against the full `req.path` to ensure robust authorization for all incoming paths.
