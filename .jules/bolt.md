## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-05-19 - Indexing Time-Series Foreign Keys for Latest-Record Fetches
**Learning:** Fetching the latest entry from a time-series table (like GpsLog) for a specific foreign key (like busId) results in a full table scan without a composite index. Prisma's `include` with `orderBy` and `take: 1` performs poorly on unindexed large tables.
**Action:** Always add a composite index (e.g. `@@index([foreignKeyId, timestampField(sort: Desc)])`) on high-volume time-series tables to prevent N+1 and full table scan bottlenecks during latest-record queries.
