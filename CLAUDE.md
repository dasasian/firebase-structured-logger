# CLAUDE.md — working conventions for this repo

## What this is

Structured logging for Firebase apps — a client logger (`/client`), a Cloud Functions
logger (`/functions`), and the `fsl` CLI (`/tools`). Published as
`@dasasian/firebase-structured-logger` — an npm library, **not** an MCP server, so there is
no MCP registry step.

## Build / test

`npm run build` (tsc) · `npm run typecheck` · `npm test`.

`typecheck` runs **two** configs. `tsconfig.json` is the build — CommonJS, `rootDir ./src`,
and it covers `src/` only. `tsconfig.check.json` covers `tests/` and `smoke/` as well, with
ESM settings and `noEmit`, because `smoke/run.ts` uses `import.meta` and CommonJS rejects it
(TS1470). Neither file was type-checked at all until #38, which is how
`entry.metadata.errorGroups` — a field the Logging client does not surface — reached a live
smoke run and reported, wrongly, that Cloud Error Reporting had grouped nothing.

That only works while the harness stays typed. `smoke/run.ts` has no `any` in it on purpose:
`any` is what let that bug through, so re-introducing one silently disarms the check for the
file that most needs it.

`tsc` does not remove output for sources you deleted, so `dist/` keeps stale files and
`npm pack` will happily ship them — `packDeploy.js` was still in the 0.4.0 tarball after
its source was removed. `prepublishOnly` runs `clean && build` for that reason. Check
`npm pack --dry-run` after deleting any source file.

`.nvmrc` pins **22** for local work — `nvm use` picks it up in this directory. It exists
because Node 20 fails in ways that look like code problems: `firebase-functions` pulls in
`jwks-rsa` → `jose` 6, which is ESM-only, so `firebase deploy` dies during codebase
analysis with `ERR_REQUIRE_ESM` and a plain `require()` of the built `/functions` entry
point does the same. CI deliberately ignores `.nvmrc` and keeps its 20/22 matrix.

**Node 22 is the supported floor.** `firebase-admin` 14 requires it, and it is the Cloud
Functions runtime people deploy to. CI runs 20 and 22 — 20 only as a courtesy check for
consumers still on `firebase-admin` 13. If you change the matrix, update the required
status checks on `main` too, or PRs wait forever on a check that never runs.

`npm test` runs the `tests/*.ts` tsx suites. Keep them green.

Most functions-side suites — `errorPayload`, `requestLogger`, `handler`, `symbolication` —
run under `FUNCTIONS_EMULATOR=true` (already set in the `test` script) so they exercise
emulator mode without live credentials, writing to a throwaway `dev.jsonl`.

**`productionOutput` and `handlerSymbolication` deliberately run with that flag UNSET.** `writeLog` has two branches
that emit structurally different entries — emulator nests `jsonPayload`, production spreads
it to top level — and for a long time only the emulator branch was tested. It captures
**stdout and stderr** (firebase-functions routes ERROR to `console.error`, so a stdout-only
capture misses every error entry) and asserts the exact bytes Cloud Logging ingests. Change
the emitted shape and this is the suite that should stop you.

`handlerSymbolication` drives `createClientLogHandler` end to end — minified stack in,
source location out. It needs no cloud: `getSourceMap` checks the embedded map before
falling through to Storage, so maps written to `sourcemaps/current/` satisfy the whole
path. `FUNCTIONS_EMULATOR` is an environment **variable**, not a process — nothing has to
be started. It uses `app-HANDLER1.js` and friends because `symbolication` writes to the
same directory under the same cwd, and a shared fixture name would let one suite's map
silently satisfy the other's lookup.

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
