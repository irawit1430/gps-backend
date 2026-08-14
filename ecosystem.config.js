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
      },
      out_file: '/var/log/voltava/api.out.log',
      error_file: '/var/log/voltava/api.err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
    },
  ],
};
