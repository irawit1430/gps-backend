🎯 **What:** Modified the `app.post('/api/schools/:schoolId/drivers')` endpoint to use a Prisma `select` clause in the `prisma.user.create()` operation to avoid exposing the generated driver password hash in the JSON response.

💡 **Why:** Removing password hashes from API responses prevents unintentional leaking of sensitive data. Even though passwords are appropriately hashed (using `bcrypt`), exposing these to clients provides no value and violates standard security and code health principles. By standardizing endpoint responses to include only non-sensitive user attributes, code maintainability and general safety are improved.

✅ **Verification:** Verified by inspecting the `prisma.user.create` call using `grep` and confirming it includes a precise `select` mapping instead of returning all fields by default. Executed the full testing suite via `npm test` using `JWT_SECRET=super-secret` to ensure existing paths still passed with no regressions.

✨ **Result:** A driver creation via POST now correctly shapes its JSON response without leaking the password hash. The change aligns the POST method with the previously patched GET method for consistency and better code health.
