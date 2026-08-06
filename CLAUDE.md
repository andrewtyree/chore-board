# CLAUDE.md

Working notes for Claude Code on this repo. Read this before changing scheduling behavior.

## Where we are — shipping v1.0 (last updated 2026-08-06)

Working through a punch list to make the repo releasable. The engine and UI were already
feature-complete; this is packaging and data safety, not features.

**Done — P0 (data loss) and P1 (release basics).** See `CHANGELOG.md` for the full list. In short:
atomic state writes with a `.bak` generation, corrupt-vs-empty handling (503, never seed over a
damaged file), automatic reconnect out of offline mode, AGPL-3.0-or-later licensing with the §13
Source link, version renumbered 2.0.0 → 1.0.0, CI on Node 18/20/22 + a Docker smoke test, and
`test/server.test.js`. The rules those introduced are written up under "Data safety" below — treat
them as part of the architecture contract.

**Next — P2: the self-hosting promise has two holes.**
1. `public/index.html:7-9` pulls Bricolage Grotesque and Inter from `fonts.googleapis.com`. On a NAS
   with no internet, or an offline family device, the typography silently falls back — and it's an
   external runtime dependency in a project whose pitch is "no dependencies, runs anywhere". Fix:
   vendor the woff2 files into `public/fonts/` with local `@font-face` (still no build step), or drop
   to a system font stack. If vendoring, add `*.woff2 binary` to `.gitattributes` — the blanket
   `* text=auto eol=lf` rule there should auto-detect binary, but be explicit.
2. No web app manifest or icons, even though README step 4 tells people to add the board to their
   home screen and `server.js:26` already has the `.webmanifest` MIME type wired up. Needs
   `public/manifest.webmanifest`, 192/512 icons, `<link rel="manifest">` and `theme-color`. iOS
   ignores manifest icons for home-screen bookmarks, so it also needs `<link rel="apple-touch-icon">`.

**Then — P3: dangling references on delete.** Deleting a person (`app.js:331`) only filters
`S.people`; chores keep `assignee`/`holder` pointing at the ghost id. `rollForward` then sets
`holder = assignee` unconditionally for explicit assignees, and `assignInstances` drops the chore to
unassigned with "Assigned person is inactive — reassign in Chores" — visible, but the wrong wording
and no bulk fix. Same shape for rooms (`app.js:256`) and matrix types (`app.js:278`), which leave
stale `${typeId}:${roomId}` keys in `matrixExclude`. Cleaning references on delete is the fix; the
engine should stay tolerant of ghosts regardless.

**Explicitly deferred past v1.0:** everything in `TODO.md` (per-entity sync). README documents
last-write-wins as a known limit. If box-checking actually hurts in real use, TODO.md's Slice 1
alone is the fix.

**Known gap:** the client reconnect path (`app.js` → `reconnect()`) is covered on the server side
and parses clean, but has not been exercised end-to-end in a browser. Worth a two-tab manual pass
before tagging v1.0.0.

## What this is

A self-hosted family chore scheduler. Vanilla ES modules + a zero-dependency Node server. No
framework, no build step, no runtime dependencies. Keep it that way unless there's a strong reason
not to — the value here is that it runs anywhere Node runs and is trivial to host on a NAS.

## Architecture contract (don't break these)

1. **All scheduling logic lives in `public/scheduler.js` and stays pure.** No DOM, no `fetch`, no
   `Date.now()` reaching into globals — dates come in as ISO strings / args. This is what makes the
   engine testable and is the single source of truth shared by the browser and the tests. If you're
   adding scheduling behavior, it goes here, and it gets a test.
2. **`public/app.js` owns side effects:** state, storage, rendering, events. It imports the engine.
   It should contain no scheduling rules — only orchestration and presentation.
3. **`server.js` is a dumb store.** It serves `public/` statically and persists one JSON blob at
   `/api/state` (GET/PUT). It has no domain knowledge and shouldn't gain any. Keep it dependency-free.
   It is *not* careless, though — see "Data safety" below; those rules are load-bearing.
4. **One persisted document.** The entire board is the object `S` in `app.js`, saved whole. Every
   mutation goes through `save()` (which bumps `S.rev` and PUTs/falls back to localStorage).

## Domain model (glossary)

- **chore** — `{id, name, minutes, priority(1–5), intervalCount, intervalUnit, adultOnly, assignee,
  lastDone, holder, assignedOn, escalated, enabled, matrixKey}`.
- **obligation** — the open instance of a chore. A chore has **at most one** open obligation at a
  time, represented by `assignedOn` (the date it came due) + `holder` (who owns it). `holder === null`
  means "needs auto-assignment". Resting chore: `assignedOn === null`.
- **cadence** — `intervalCount` × `intervalUnit` (days/weeks/months/years). Drives when the next
  obligation opens, measured from `lastDone` (or "now" if never done).
- **grace** — days a holder has to complete an obligation before it's **delinquent**
  (`settings.graceDays`, default 3).
- **delinquency cycle** — `floor((today − assignedOn) / grace)`. 0 = on time, 1 = first delinquency, …
- **escalation** — once an *auto-held* (no explicit `assignee`) obligation owned by a *child* reaches
  `settings.escalateAfter` cycles, it's flagged `escalated`, the holder is released, and
  `buildInstances` forces it adult-only so it reassigns to an adult. Explicit assignees never escalate.
- **holder vs assignee** — `assignee` is a user-set lock ("always this person"). `holder` is the
  current owner, which the scheduler sets for auto chores and persists so delinquency/escalation
  follow the same person across refreshes. `assignee` always wins over `holder`.
- **matrix** — `rooms` × `matrixTypes`, minus `matrixExclude` (an array of `"typeId:roomId"` keys).
  `applyMatrix` regenerates derived chores (those with `matrixKey`), scaling `minutes` by room size
  (`SIZE_FACTORS`) and **preserving per-cell state** (`lastDone`, `holder`, `assignedOn`, `assignee`,
  `enabled`) across re-applies. Manual chores (no `matrixKey`) are untouched.

## Engine entry points (in order of a "Refresh week")

1. `rollForward(chores, {todayISO, horizonISO, grace, escalateAfter, people})` — mutates chores:
   opens due obligations, releases stale child obligations for escalation. The only mutating engine fn.
2. `buildInstances(chores, weekStartISO, todayISO, grace)` — pure → schedulable instances for the week
   (sets `delinquent`, `lateCycles`, `escalated`, and forces `adultOnly` when escalated).
3. `assignInstances(instances, people)` — pure → `{assignments, unassigned, load, holderOf}`.
   - Locked (holder or assignee) → **force-placed** on that person, *ignoring* budget and task-length
     caps (it's a must-do; the UI shows the over-budget meter in red). Never dropped to `unassigned`.
   - Auto → eligible filtered by `adultOnly` + per-person `maxTaskMinutes`; placed by first-fit on the
     day nearest its target, choosing the person with the **highest remaining fraction** of weekly
     capacity. This proportional balance is deliberate — balancing by raw minutes starves the kids.

`app.js#generate()` then writes `holderOf` back onto each chore so the holder sticks.

## Invariants worth a test if you touch the engine

- Adult-only (unlocked) never lands on a child; explicit assignee/escalation may override.
- A locked/over-budget task is force-placed, not unassigned.
- Exactly one open obligation per chore; completing clears it and starts the next cadence cycle.
- `applyMatrix` preserves per-cell state and honors `matrixExclude` and size scaling.
- Escalation: child + auto + `cycles ≥ escalateAfter` → adult; forced assignee never escalates.

`test/scheduler.test.js` covers all of the above. **Run `npm test` after any engine change.**

## Data safety (don't regress these — they're covered by `test/server.test.js`)

- **Writes are atomic and serialized.** `writeState` queues through a promise chain so overlapping
  PUTs can't interleave, and `writeNow` does tmp → copy old to `.bak` → `rename`. Never `writeFile`
  straight onto `DATA_FILE`; a torn write there is a destroyed family board.
- **Corrupt ≠ empty.** `readState` returns `{ok:false}` when a state file exists but won't parse
  (after trying `.bak`), and `GET /api/state` answers **503**. The client must *never* seed defaults
  in response to that — seeding over a truncated file is how you silently lose everything. "No file
  at all" is the only case that means "seed me".
- **Degraded sync must be recoverable.** `syncMode` may drop to `local`/`error`, but `pull()` calls
  `reconnect()` on every tick so a blip can't strand a device on `localStorage` for the session.
  Reconciliation is whole-document by `rev`, matching the rest of the app.

## Conventions

- ES modules everywhere (`"type": "module"`). Browser loads `app.js` via `<script type="module">`.
- 2-space indent, semicolons, single quotes. Match the existing terse style in `scheduler.js`.
- No new dependencies without updating this file and the Dockerfile, and justifying it in the PR.
- UI copy: plain, active voice, sentence case. Errors say what happened and how to fix it.
- Don't introduce `localStorage`/`sessionStorage` as the *primary* store — it's the offline fallback
  only. The server is the source of truth when present.

## Gotchas

- Dates are date-only and local; always go through the helpers in `scheduler.js` (`parseISO`,
  `toISO`, `addDays`, `addCadence`) — don't hand-roll `Date` math, especially for months/years.
- The live-sync `pull()` skips while an input/select is focused so it won't clobber an in-progress
  edit. Keep that guard if you change sync.
- `data/state.json` is gitignored. Don't commit real family data.
