## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2023-11-20 - Indexing frequently filtered foreign keys and time-series tables
**Learning:** Adding indexes on frequently filtered foreign keys (like `schoolId`, `routeId`, `busId`) and a composite index on time-series tables (`GpsLog` with `[busId, timestamp(sort: Desc)]`) is crucial in SQLite to prevent O(N) sequential scans, especially when retrieving the latest state (e.g., latest GPS log for a bus).
**Action:** Always verify access patterns for frequently used API endpoints and ensure corresponding foreign keys and sort fields are properly indexed in the Prisma schema.
