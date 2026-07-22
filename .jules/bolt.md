## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2026-07-22 - Database Indexes for Frequent Queries
**Learning:** High-volume time-series queries and frequent filtering by foreign keys (e.g., `schoolId`) can lead to full table scans and performance bottlenecks if not properly indexed.
**Action:** Use composite indexes like `@@index([busId, timestamp])` for time-series fetches, and add standard indexes on frequently filtered foreign keys (like `schoolId` and `parentId`) in Prisma schemas.
