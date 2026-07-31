## 2024-05-18 - Caching Telemetry Data
**Learning:** The /api/telemetry endpoint is hit very frequently and queries the database for the same bus and active trips on every ping.
**Action:** Introduce a simple Map to cache bus information with a TTL to prevent hitting the database for high-frequency telemetry endpoints.
## 2026-07-19 - Concurrent Database Queries
**Learning:** Sequential, independent database queries inside endpoints (like multiple `count()` calls) lead to an N+1 query pattern latency issue, as each query waits for the previous one to complete.
**Action:** Always wrap independent asynchronous database operations in `Promise.all()` to execute them concurrently, reducing overall request processing time.
## 2024-07-31 - Parallelize network requests in telemetry simulation
**Learning:** Sequential `axios.post` requests in a loop inside `simulateFleet` was causing a bottleneck where each request had to wait for the previous one to finish. By using `Promise.all` and mapping the requests to an array of promises, we can fire off all telemetry requests concurrently. This speedup is significant (approx. 18.6x faster for 50 concurrent requests in the benchmark).
**Action:** When making multiple independent network requests within a loop, collect the promises in an array and `await Promise.all()` instead of `await`-ing each individually inside the loop. This ensures that network latency is overlapping instead of cumulative.
