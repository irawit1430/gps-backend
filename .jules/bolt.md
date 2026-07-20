## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-05-18 - Database Indexes on High-Volume Tables
**Learning:** High-volume time-series tables (like `GpsLog`) queried for the latest entry per device can cause massive database slow-downs due to full table scans.
**Action:** Always add composite indexes (e.g., `@@index([busId, timestamp])`) to time-series tables when fetching the latest record, and standard indexes for foreign keys (e.g., `schoolId`) used heavily in filtering.
