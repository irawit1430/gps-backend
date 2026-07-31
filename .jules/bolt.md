## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-11-20 - Adding Database Indices
**Learning:** High-volume time-series queries and frequent filtered queries on foreign keys (like `schoolId` and `parentId`) can cause performance issues due to full table scans when missing appropriate database indices.
**Action:** Use standard indices like `@@index([schoolId])` on heavily filtered foreign keys and composite indexes like `@@index([busId, timestamp(sort: Desc)])` for high-volume time-series tables to prevent full table scans and significantly improve query performance.
## 2024-07-31 - Caching TCP Server Lookups
**Learning:** The TCP Server's `socket.on('data')` loop hits the database on every parsed packet to resolve the device IMEI to a Bus record. This creates an N+1 query bottleneck when processing large chunks of telemetry.
**Action:** Implemented a `Map`-based cache (`busCache`) with a TTL to store the IMEI-to-Bus mapping, significantly reducing database lookups for consecutive packets from the same device.
