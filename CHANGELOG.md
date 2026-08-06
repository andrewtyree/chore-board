# Changelog

## v1.0.0 — first tagged release

The scheduling engine and UI were already feature-complete; this release is about making the thing
safe to hand to a household and leave running.

### Data safety
- **Atomic state writes.** `state.json` is written via temp file + `rename`, with one generation
  kept in `state.json.bak`. A crash or power cut can no longer leave a half-written board.
- **Concurrent PUTs are serialized** through a write queue instead of racing on the same file.
- **A corrupt state file is no longer mistaken for an empty one.** The server falls back to `.bak`,
  and if that fails too `GET /api/state` returns 503. Previously an unreadable file made the client
  seed sample data and write it straight over the damaged original.
- **Offline mode recovers.** A failed save used to strand a device on `localStorage` for the rest of
  the session; the app now probes `/api/health` and rejoins the shared board automatically,
  reconciling by revision.

### Release
- Licensed under the **GNU AGPL v3 or later**, copyright Estrella Tyree, with a Source link in the
  app per §13.
- Version renumbered to 1.0.0 (was 2.0.0, which never corresponded to a release).
- CI on Node 18/20/22 plus a Docker build-and-serve smoke test.
- `test/server.test.js` covers the store: atomic writes, backup fallback, corruption handling,
  and static-file path traversal.
