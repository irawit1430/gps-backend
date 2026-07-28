## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.

## 2024-05-30 - Optimize Latest-Record Fetches in Time-Series Tables
**Learning:** High-frequency APIs reading the latest record from a time-series table (like `gpsLogs[0]` with `timestamp: 'desc'`) cause full table scans without specific indexing. Standard composite indexing isn't optimal unless the sort order is explicitly provided.
**Action:** Always add a composite index mapping the foreign key (e.g. `busId`) and the timestamp with a descending modifier: `@@index([busId, timestamp(sort: Desc)])` to convert O(N) table scans into O(log N) operations as the table grows.
