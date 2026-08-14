# scripts/

Ad-hoc scripts kept out of the main runtime.

- `simulate.js`, `test_client.html`, `test-blackbox-tcp.js`, `test-firebase-write.js`:
  local end-to-end test drivers for the TCP listener + Firebase sync.
- `patch_*.js`: historical automated-patch artifacts. Kept for provenance; safe to
  delete once no longer referenced by any run history.
- `tunnel.js`: localtunnel bootstrap for exposing dev instances. Not for production.
- `submit.js`, `pre_commit.py`: repo-tooling helpers.

Nothing in this directory is loaded by `index.js`, `server.js`, or `tcp-server.js`.
