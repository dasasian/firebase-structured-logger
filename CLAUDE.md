# CLAUDE.md — working conventions for this repo

## What this is

Structured logging for Firebase apps — a client logger (`/client`), a Cloud Functions
logger (`/functions`), and the `fsl` CLI (`/tools`). Published as
`@dasasian/firebase-structured-logger` — an npm library, **not** an MCP server, so there is
no MCP registry step.

## Build / test

`npm run build` (tsc) · `npm run typecheck` (tsc --noEmit) · `npm test`.

`npm test` runs the `tests/*.ts` tsx suites. Keep them green.

Most functions-side suites — `errorPayload`, `requestLogger`, `handler`, `symbolication` —
run under `FUNCTIONS_EMULATOR=true` (already set in the `test` script) so they exercise
emulator mode without live credentials, writing to a throwaway `dev.jsonl`.

**`productionOutput` deliberately runs with that flag UNSET.** `writeLog` has two branches
that emit structurally different entries — emulator nests `jsonPayload`, production spreads
it to top level — and for a long time only the emulator branch was tested. It captures
**stdout and stderr** (firebase-functions routes ERROR to `console.error`, so a stdout-only
capture misses every error entry) and asserts the exact bytes Cloud Logging ingests. Change
the emitted shape and this is the suite that should stop you.

Two support modules, not suites themselves:

- `tests/testHelpers.ts` — `assert`, `reportResults`, `readLastEntry(dir)`, `clearLog(dir)`,
  `makeRequest(payload)`. Every suite uses these; don't re-roll them per file.
- `tests/browserStubs.ts` — in-memory `sessionStorage`, a fake `window` with
  `dispatchWindowEvent`/`listenerCount`, a stub `navigator`, and `withFrozenTime`.
  **Import it before the module under test** — `rateLimiter` reads `window` and
  `client/logger` reads `navigator` at module load, so a later stub is too late.

`errorPayload` is the parity suite: the client and functions loggers must build an identical
`ErrorPayload`. They share `src/shared/error.ts` now, but they drifted once before.

## Module-scoped state — the rule

Two bugs came from the same mistake, so it is worth stating plainly:

> **A config value stored in module scope must not be accepted as a per-call or
> per-instance parameter.**

`new Logger({ rateLimitOptions })` and `createClientLogHandler({ bucketName })`
both *looked* scoped to the thing being constructed. Neither was — a second call
silently changed the first caller's behaviour, with no error. The parameter
position was the lie, not the global state.

Two honest resolutions when you hit this: make it global in the API too (a
separate `configureX()` the caller invokes once), or make it genuinely
per-instance.

What is legitimately module-scoped here, and why:

| State | Why global is correct |
|---|---|
| breadcrumbs, current screen, active activity | one user, one session, one path |
| the client `Logger` singleton | see below |
| source-map and TraceMap caches | pure caches, keyed by content |
| `AsyncLocalStorage` in `requestLogger` | per-request by design, not global |

**The client logger is a session singleton.** `Logger` is exported as a *type
only* — annotate with `Logger<AppLabels>`, construct via `initLogger()`. A
second instance would silently share breadcrumbs, screen, activity and the
rate-limit budget while looking independent. The functions side is the opposite
and correctly so: requests are concurrent, so each gets its own writer via
`AsyncLocalStorage`.

`tests/publicApi.ts` pins the exported names of each entry point.
`tests/configureTwice.ts` asserts the second-call semantics of every
`configureX`/`init`. **A new configure/init function needs a case in that
file** — its absence is what let both bugs ship.

## Releasing

A library → **npm only** (no registry, no `server.json`, no tag-triggered publish workflow).
Full process + gotchas: `../PUBLISHING.md`. The short version:

1. Update `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com) format): rename
   `[Unreleased]` to `[X.Y.Z] — <date>`, open a fresh empty `[Unreleased]`, and update the
   two link refs at the bottom of the file.
2. Bump `version` in `package.json`.
3. Commit `chore: release X.Y.Z` and push.
4. `npm publish` — needs your OTP. Traps: a `404 on PUT` = lapsed token (`npm login`);
   `npm view` can 404 for ~2 min after a *successful* publish (confirm with
   `npm access list packages`, don't re-publish).
5. `git tag vX.Y.Z && git push origin vX.Y.Z`; `gh release create vX.Y.Z` with the CHANGELOG notes.
6. Update the `dasasian.com/firebase-structured-logger` page in `dasasian-web`. Only
   `npm publish` and the release need your credentials; an agent drives the rest.
