## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-07-24 - Database index for Latest Locations
**Learning:** The application frequently queries the latest location for buses, doing `bus.gpsLogs[0]` with `orderBy: { timestamp: 'desc' }` without an index, which requires a full table scan on `GpsLog` as data grows.
**Action:** Add a composite index on `@@index([busId, timestamp(sort: Desc)])` to `GpsLog` schema to optimize retrieving the latest log for buses.
