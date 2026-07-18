## 2025-01-20 - Insecure Random Number Generation for Passwords
**Vulnerability:** Weak temporary passwords were being generated using `Math.random().toString(36).slice(-8)`.
**Learning:** `Math.random()` is not a cryptographically secure pseudorandom number generator (CSPRNG). If an attacker predicts the output of `Math.random()`, they could determine the temporary passwords given to users.
**Prevention:** Use `crypto.randomBytes()` from Node.js's native `crypto` module to generate cryptographically secure random values for passwords and other sensitive tokens.
