// PM2 config for the GCE VM.
// Single-process for now: HTTP + Socket.IO + TCP all live in index.js.
// Split into two apps later if we need horizontal scale (would need a Redis
// pub/sub layer between the TCP process and the HTTP process so location_update
// events reach connected sockets).

module.exports = {
  apps: [
    {
      name: 'voltava-fleet',
      script: 'index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 20000, // must exceed the graceful-shutdown deadline in index.js
      wait_ready: false,
      env: {
        NODE_ENV: 'production',
        // Every "today" boundary in this service is server-local: today's attendance,
        // the no-show window, the GpsLog retention cutoff. On a UTC host the school day
        // starts at 05:30 IST — invisible while every run happens between 06:00 and
        // 18:00 local, and wrong the moment one doesn't.
        //
        // It has to live here and not in .env: Node fixes its timezone at process
        // start, long before dotenv assigns process.env.TZ, so a TZ line in .env sets a
        // variable and changes nothing. PM2 sets this before spawning, so it takes.
        // /healthz reports utcOffsetMinutes, which is how to check it actually applied.
        TZ: 'Asia/Kolkata',
      },
      out_file: '/var/log/voltava/api.out.log',
      error_file: '/var/log/voltava/api.err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
    },
  ],
};
