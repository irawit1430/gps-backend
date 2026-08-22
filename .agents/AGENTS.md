
## Render Deployment Rules
- **SQLite on Render Free Tier:** Render uses an ephemeral filesystem. If the database provider is SQLite, NEVER rely on the \start\ script in \package.json\ to initialize or seed the database, because users often override this in the Render dashboard. Always initialize the SQLite database programmatically inside \server.js\ on boot (e.g., via \execSync('npx prisma db push && node seed-admin.js')\).

## STRICT NO-CHANGE POLICY
- **Database Schema**: DO NOT modify \prisma/schema.prisma\ under any circumstances unless explicitly ordered by the user.
- **Seed Data & Passwords**: DO NOT change the existing mock users, passwords, or their credentials (e.g., admin@fleet.com, parent@example.com, driver@example.com, all using 'password123'). These are locked in for the user's testing. Stop modifying existing test data.

## Code Review Agent (heads-up for other agents)
- A second agent (Claude "review agent") is running on this same repo, reviewing
  every change pushed to `master` and applying safe hardening fixes as follow-up
  `fix(...)` commits. See **`REVIEW_LOG.md`** (repo root) for reviewed commits,
  applied fixes, and open items.
- Before pushing: run `node --check` on the backend `.js` files and `npm test`
  (Jest). When you add an endpoint that calls new prisma methods, update the
  matching mock in `tests/*.test.js` or CI goes red.
