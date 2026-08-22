## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-11-20 - Adding Database Indices
**Learning:** High-volume time-series queries and frequent filtered queries on foreign keys (like `schoolId` and `parentId`) can cause performance issues due to full table scans when missing appropriate database indices.
**Action:** Use standard indices like `@@index([schoolId])` on heavily filtered foreign keys and composite indexes like `@@index([busId, timestamp(sort: Desc)])` for high-volume time-series tables to prevent full table scans and significantly improve query performance.
## 2024-05-19 - Optimizing "Active Device" counting
**Learning:** Fetching distinct rows (using `findMany` with `distinct`) just to get the count of items that have associated time-series records is inefficient as it downloads an array of objects into memory.
**Action:** Use relational counts like `bus.count({ where: { gpsLogs: { some: { timestamp: { gte: ... } } } } })` instead to let the database handle the aggregation efficiently without pulling rows into Node.js.
## 2024-05-19 - Caching TCP Telemetry Data
**Learning:** High-frequency TCP socket ingestion querying the database repeatedly (e.g., IMEI to Bus lookup on every packet) creates an N+1 scaling bottleneck for the hardware connection listener.
**Action:** Use an in-memory Map cache with a TTL (e.g., 60s) to map hardware identifiers (like IMEI) to database entities, similar to the HTTP endpoints, significantly dropping repeated DB reads.
