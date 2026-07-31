## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
## 2025-01-20 - Exposing Error Details to Clients
**Vulnerability:** The route `/api/student-route-mappings` was returning the internal error message (`err.message`) in its 500 response, which could expose sensitive information.
**Learning:** In catch blocks for route handlers, raw error messages can inadvertently leak system details like stack traces or database structure to clients.
**Prevention:** Ensure that all error responses sent to the client provide a generic, safe message (e.g., `'Internal server error'`) while maintaining internal visibility by logging the full error server-side.
## 2026-07-31 - Mass Assignment Vulnerability in Settings & Preferences
**Vulnerability:** The `/api/parents/:id/preferences` endpoint blindly passed `req.body` into `JSON.stringify` and saved it to `notificationSettings`, allowing arbitrary keys to be persisted.
**Learning:** Mass assignment can occur not just in Prisma `data` objects, but also when blindly serializing `req.body` into JSON fields.
**Prevention:** Always strictly destructure allowed fields (e.g. `{ pushEnabled, emailEnabled, smsEnabled }`) before serialization or database storage.
