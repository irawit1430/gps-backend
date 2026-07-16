## 2024-05-24 - [CRITICAL] Remove Hardcoded JWT Secret Fallback

Vulnerability: A hardcoded fallback JWT secret ('super-secret-fleet-key') was present in `index.js`, meaning if the environment variable was missing, all issued JWTs would use a well-known, insecure secret, allowing attackers to forge tokens.
Learning: Defaulting to a hardcoded secret undermines the entire authentication system.
Prevention: The application should fail securely. If a required secret like `JWT_SECRET` is missing during application startup, the application must log a critical error and exit immediately (`process.exit(1)`) rather than falling back to an insecure default.
