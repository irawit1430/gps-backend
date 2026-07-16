## 2024-07-16 - Hardcoded JWT Secret and Information Leakage in Authentication API
**Vulnerability:** A hardcoded JWT secret ('super-secret-fleet-key') was used as a fallback in `jwt.sign`. Also, the `/api/auth/login` endpoint leaked internal error details (`err.message`) in its 500 response.
**Learning:** Hardcoded secrets and internal stack traces/messages can easily leak from APIs, especially when rapid iteration overlooks environment variables or standard error responses.
**Prevention:**
- Enforce the presence of critical secrets via environment variables at application startup, failing securely if they are missing.
- Implement generic error messages (e.g., 'An internal server error occurred') for unexpected exceptions in production APIs to prevent information leakage.
