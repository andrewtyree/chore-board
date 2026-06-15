# CLAUDE.md

Working notes for Claude Code on this repo. Read this before changing scheduling behavior.

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
