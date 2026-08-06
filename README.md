# ChoreBoard

A self-hosted household chore scheduler. You describe each chore (priority, duration,
cadence, who's allowed to do it) and your family's daily time budgets, and it generates a
balanced weekly assignment grid — packing each person's day up to their time budget,
respecting adult-only rules, and tracking what's overdue.

Built to run on a home server (e.g. a Synology NAS) and be opened from any family device on
the same network. State is shared: everyone sees and edits the same board.

![ChoreBoard — the weekly assignment grid, with per-person time-budget meters and color-coded chore cards](docs/screenshot.png)

## What it does

- **Smart weekly schedule.** Each person-day is a time bin (default 30 min weekdays / 60 min
  weekends, per-person). The engine packs due chores into bins, balancing load by *fraction of
  capacity* so kids aren't starved and adults aren't buried, and surfaces anything that won't fit.
- **Obligation + delinquency lifecycle.** A chore comes due on its cadence and is assigned to a
  *holder*. They have a grace window (default 3 days) to check it off. Miss it and it goes
  **delinquent** — pinned to the same person at the top of their day. After a configurable number
  of delinquency cycles, an auto-assigned chore **escalates to an adult**.
- **Flexible cadence.** Every *N* days / weeks / months / years, with real calendar math.
- **Per-chore assignment.** Lock a chore to one person, or let the scheduler auto-balance it.
- **Room × chore matrix.** Declare rooms (with sizes) and matrix chore types (Tidy, Vacuum, Mop…);
  generate one chore per compatible room×type cell. Duration scales with room size, and a
  compatibility grid lets you exclude combinations (e.g. don't mop a carpeted room).

## Quick start (local)

Requires **Node 18+**. No dependencies, no build step.

```bash
node server.js
# open http://localhost:8080
```

Run the engine tests:

```bash
npm test            # == node test/scheduler.test.js
```

You can also open `public/index.html` directly as a file — it falls back to per-device
`localStorage` (the top-right badge shows **Local only** instead of **Shared**). Running the
server is what makes the board shared across devices.

## Project layout

```
chore-board/
├── server.js              # zero-dependency static server + /api/state JSON store
├── package.json           # ES modules; "start" and "test" scripts; no runtime deps
├── public/
│   ├── index.html         # markup + tab shell
│   ├── styles.css         # all styling
│   ├── scheduler.js       # PURE engine: cadence, obligations, assignment, matrix (no DOM/IO)
│   └── app.js             # state, storage, rendering, event wiring (imports scheduler.js)
├── test/
│   ├── scheduler.test.js  # the pure engine
│   └── server.test.js     # the store: atomic writes, backup fallback, static serving
├── data/                  # runtime state.json (gitignored) — the shared source of truth
├── .github/workflows/     # CI: tests on Node 18/20/22 + a Docker smoke test
├── Dockerfile
└── docker-compose.yml
```

All scheduling logic lives in `public/scheduler.js` as pure functions and is covered by
`test/scheduler.test.js`. See `CLAUDE.md` for the architecture contract and `VISION.md` for the
roadmap and open design decisions.

## Deploy on a Synology NAS (StratoSaturn)

The recommended path is **Container Manager** (Docker), because it's self-contained and survives
DSM updates.

1. Copy this folder to a share, e.g. `/volume1/docker/chore-board/`.
2. In DSM open **Container Manager → Project → Create**.
   - Project name: `chore-board`
   - Path: the folder you copied
   - Source: **Use existing docker-compose.yml**
3. Build and run. The board is then at `http://<NAS-IP>:8080` from any device on the LAN.
4. (Optional) Give the NAS a reserved IP/hostname in your router so the URL is stable, and bookmark
   it on each family device's home screen.

Shared state persists to `./data/state.json` on the NAS (mounted into the container at `/data`),
so it survives container rebuilds. See [Your data](#your-data) for how it's written and backed up.

### Without Docker

Container Manager isn't installed, or you'd rather not use it:

- **Node directly.** Install the Node.js package from Package Center, then run `node server.js`
  from the project folder (set `PORT`/`DATA_FILE` as needed). Use **Task Scheduler → triggered task
  (boot-up)** to start it automatically.
- **Web Station (static only).** Web Station can serve `public/` as a static site, but *static
  hosting can't share state* — every device would get its own private copy via `localStorage`.
  Only use this if you don't need a shared board.

## Configuration

| Env var     | Default            | Purpose                                  |
|-------------|--------------------|------------------------------------------|
| `PORT`      | `8080`             | Port the server listens on               |
| `DATA_FILE` | `./data/state.json`| Where shared state is persisted          |

## Your data

State lives in one file (`data/state.json` by default). The server never writes it in place: it
writes `state.json.tmp`, copies the current file to `state.json.bak`, then renames the temp file
over the original. A crash or power cut therefore leaves either the old board or the new one, never
a half-written one — and if `state.json` is ever unreadable, the server falls back to `.bak` and
logs loudly.

If both files are damaged, `GET /api/state` returns **503** rather than an empty board, and the app
shows **Server data unreadable** and keeps saving locally. This is deliberate: it stops a corrupt
file from being silently replaced with fresh sample data. Restore the file (or delete it to start
over) and the app reconnects on its own.

Back it up by copying `data/state.json`, or include the share in your normal NAS backup.

## Notes & limits

- **Last-write-wins.** The whole board is one JSON document; concurrent edits from two devices can
  clobber each other. The app polls every 15s and on window focus to pull others' changes. Fine for
  a family; see `TODO.md` for the per-entity sync design and `VISION.md` for the broader roadmap.
- **Offline edits are per-device.** If the server goes away, the board keeps working and saves to
  that device's `localStorage`; the badge turns amber. When the server returns the app rejoins
  automatically, keeping whichever copy has the higher revision. Two devices that both edited while
  offline can't be merged — the later reconnect wins.
- **No authentication.** Intended for a trusted LAN. Don't expose it directly to the internet
  without putting auth/a reverse proxy in front.

## License

Copyright (C) 2026 Estrella Tyree. Licensed under the [GNU AGPL](LICENSE), version 3 or (at your
option) any later version.

If you run a modified version where other people can reach it over a network, you have to offer
them your source — hence the **Source** link in the app's top bar. Point it at your own fork if you
publish one.
