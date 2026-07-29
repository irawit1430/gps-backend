## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-05-19 - Time-Series Query Optimization
**Learning:** Querying the latest log entry (e.g., `take: 1, orderBy: { timestamp: 'desc' }`) on a large time-series table like `GpsLog` can cause full table scans if no appropriate index exists.
**Action:** Use composite indexes with descending sort order (e.g., `@@index([busId, timestamp(sort: Desc)])`) on high-volume tables to optimize latest-record fetch latency.
