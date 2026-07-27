## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-11-20 - Indexing for high-frequency queries
**Learning:** Fetching the latest GPS logs per bus inside map endpoints can cause a bottleneck due to full table scans when the `GpsLog` table grows rapidly. Using `take: 1` and `orderBy: { timestamp: 'desc' }` isn't fast without the right indexes.
**Action:** Adding a composite index `@@index([busId, timestamp(sort: Desc)])` to the `GpsLog` model in Prisma allows the database to instantly locate the most recent record for a specific bus without scanning all its previous locations.
