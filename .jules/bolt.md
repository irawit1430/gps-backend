## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-05-24 - [GpsLog Latest-Record Performance]
**Learning:** High-frequency GPS tracking systems frequently query the latest location of devices, resulting in full table scans if only the foreign key is indexed.
**Action:** Always add composite indexes with descending sort (e.g., `@@index([busId, timestamp(sort: Desc)])`) to time-series logs for O(1) latest-record fetches.
