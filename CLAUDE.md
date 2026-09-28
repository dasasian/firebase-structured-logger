# CLAUDE.md — working conventions for this repo

## What this is

Structured logging for Firebase apps — a client logger (`/client`), a Cloud Functions
logger (`/functions`), and the `fsl` CLI (`/tools`). Published as
`@dasasian/firebase-structured-logger` — an npm library, **not** an MCP server, so there is
no MCP registry step.

## Build / test

`npm run build` (tsc) · `npm run typecheck` · `npm test`.

**TypeScript 6, not 7, on purpose.** Both were tried against this repo: the emitted `.js`
is byte-identical across 5.9, 6.0 and 7.0, and 7 changes only quote style in one `.d.ts`.
6 is chosen because 7.0 has no programmatic compiler API until 7.1, and tools this
package may want (typedoc, typescript-eslint) need it. Both builds use `module`/
`moduleResolution: node16` — TS 7 removed `Node` (node10) — so moving to 7 later is a
version bump. Dependabot ignores TypeScript majors for that reason.

`typecheck` runs **two** configs. `tsconfig.json` is the build — CommonJS, `rootDir ./src`,
and it covers `src/` only. `tsconfig.check.json` covers `tests/` and `smoke/` as well, with
ESM settings and `noEmit`, because `smoke/run.ts` uses `import.meta` and CommonJS rejects it
(TS1470). Neither file was type-checked at all until #38, which is how
`entry.metadata.errorGroups` — a field the Logging client does not surface — reached a live
smoke run and reported, wrongly, that Cloud Error Reporting had grouped nothing.

`.gitignore` ignores `*.json` (Firebase credentials) and lists the exceptions. A new JSON
config needs its own `!` line, or `git add -A` skips it silently and it only exists on
your machine — `tsconfig.check.json` did exactly that, and CI failed with TS5058.

That only works while the harness stays typed. `smoke/run.ts` has no `any` in it on purpose:
`any` is what let that bug through, so re-introducing one silently disarms the check for the
file that most needs it.

`tsc` does not remove output for sources you deleted, so `dist/` keeps stale files and
`npm pack` will happily ship them — `packDeploy.js` was still in the 0.4.0 tarball after
its source was removed. `prepublishOnly` runs `clean && build` for that reason. Check
`npm pack --dry-run` after deleting any source file.

`.nvmrc` pins **22** for local work — `nvm use` picks it up in this directory. Keep the
installed 22 current (`nvm install 22`): jsdom 30, a test dependency, needs 22.22.2 or
later. Node 20 fails in ways that look like code problems: `firebase-functions` pulls in
`jwks-rsa` → `jose` 6, which is ESM-only, so `firebase deploy` dies during codebase
analysis with `ERR_REQUIRE_ESM` and a plain `require()` of the built `/functions` entry
point does the same.

**Node 22 is the supported floor, and CI runs 22 and 24.** `engines` says `>=22`;
`firebase-admin` 14 and `@google-cloud/storage` 8 both require it; 24 is the current LTS.
Node 20 was dropped at 1.0 — it reached end of life on 2026-04-30 and gets no security
fixes. If you change the matrix, update the required status checks on `main` too
(`build (22)`, `build (24)` today), or PRs wait forever on a check that never runs.

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

`storageChain` also runs with the flag unset. `firebase-admin` is an optional peer, so
Storage resolves down a chain (firebase-admin → a named bucket via `@google-cloud/storage`
→ none); the suite stages "not installed" with a `Module._load` hook, because the package
is always present in this repo. `STORAGE_EMULATOR_HOST` points at a closed local port in
it and in `productionOutput`, so no attachment upload can reach real Storage with this
machine's credentials.

`entrySize` runs with the flag unset too — the 90 KiB shrink-and-warn path lives entirely
in `writeLog`'s production branch; the emulator branch writes to a local file with no
line-length ceiling, so there is nothing there to test. It reuses `storageChain`'s
`Module._load` hook for the "no Storage at all" case, and `productionOutput`'s closed-port
`STORAGE_EMULATOR_HOST` so the overflow upload fails fast instead of reaching real Storage.
One case needs the failure itself — it asserts the failed upload names the overflow
object — and that warning arrives from the upload's own `.catch`, asynchronously, after
`writeLog` has already returned; the test has to keep its `console.warn` stub in place
across a flush, not just the synchronous call, or the warning fires after the stub is
gone and the assertion sees nothing.

**`npm run smoke:install`** is the check nothing in `npm test` can do: it builds, packs,
installs the tarball into an empty temp directory with no optional peers, and sends one
ERROR through `createHttpLogHandler` from CommonJS and ESM. It needs the npm registry and
nothing else. Run it before a release — it is how the `firebase-admin` import in
`sourceMapCache.ts` was found, after a require hook that blocked only `firebase-functions`
had passed.

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

**Repeat summaries live in `localStorage`, and that is shared across tabs.** The budget
and duplicate counts are per tab (`sessionStorage`), but a pending summary has to survive
the tab closing, so it goes where every tab of the origin can see it. Each summary has its
own id, is keyed by signature + `releaseId` + `userId`, and is removed by the tab that
sends it; a rare double-send is visible by that id. Anything added there needs the same
treatment: an id, an owner, a size cap and an expiry.

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

## Shared SDKs — one copy in the user's tree

`@google-cloud/storage` is a real dependency, and users almost always have a second
route to it: `firebase-admin` brings it as an optional dependency (13.x → `^7`, 14.5+ →
`^8`). If our range and theirs do not overlap, npm installs two copies. So the range is
`^7.19.0 || ^8.1.0`, wide on purpose, the way `firebase-functions` accepts four majors
of `firebase-admin`: npm reuses whichever copy is already there. Widening a range is
not a breaking change. `npm run smoke:install` installs each major and pushes an
attachment through it, so both keep working rather than merely loading. Keep the
range covering every major a supported `firebase-admin` uses.

## Optional peers — never at module load

`firebase`, `firebase-functions` and `firebase-admin` are optional peers, and the package
has to load without any of them: the browser half posts anywhere, and
`createHttpLogHandler` runs on Cloud Run or any Node server that may not be Firebase at
all. A top-level import of a peer breaks that for everyone who has not installed it, and
nothing in `npm test` notices on its own, because this repo always has them installed.
That shipped twice in one release cycle (#39): first `firebase-functions`, then
`firebase-admin/storage`, which a check for the first did not cover.

So a peer is loaded lazily, in a **named loader at the top of the file** with a comment
saying why — `loadFirebaseWrite`, `loadFirebaseHttps`, `loadFirebaseAdminStorage` — and
its types come from an `import type` line, which erases. `require` inside the loader, not
`await import`: the call sites are synchronous, and this CommonJS build compiles a
dynamic import to `require` anyway.

Where a peer is missing, say what that costs, once — never fail silently. The Storage
chain in `sourceMapCache.ts` is the worked example.

`tests/loadsWithoutOptionalPeers.ts` checks every `src/` file for a top-level value
import of any peer. `npm run smoke:install` does it for real against the packed tarball.

## fsl doctor — facts, not guesses

Doctor reports only what it can read from a file with a fixed format — `firebase.json`,
`package.json`, `node_modules/*/package.json`, `dist/`, `.release` — and never infers
from source code. A check that has to guess ("is `initLogger` called?") stays out, or
ships later as a finding marked as a hint. A doctor that is sometimes wrong is ignored.

A check that cannot run is the error `could-not-check`, never a pass: expo-doctor once
exited 0 when it could not read its config, and CI went green on projects nobody
checked. The finding ids and `--json` fields are public API from 1.0.

## Tests run from a fresh clone

Everything in `npm test` and `npm run smoke:install` must run for someone who has just
cloned the repo and run `npm install` — no Google Cloud project, no `.env` files, no
installs in `smoke/`. Doctor's tests build small fake projects in temp folders rather
than pointing at `smoke/functions` or `smoke/cloudrun`, which depend on the maintainer's
private smoke setup. Only `npm run smoke` needs a real project.

## Releasing

A library → **npm only** (no registry, no `server.json`, no tag-triggered publish workflow).
Full process + gotchas: `../PUBLISHING.md`. The short version:

1. Update `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com) format): rename
   `[Unreleased]` to `[X.Y.Z] — <date>`, open a fresh empty `[Unreleased]`, and update the
   two link refs at the bottom of the file.
2. Bump `version` in `package.json`.
3. Commit `chore: release X.Y.Z` and push.
4. **Wait for CI on `main` to go green** (`gh run list --branch main --limit 1`). 0.7.0
   shipped on a red `main`: `tsconfig.check.json` was never committed, local typecheck
   passed because the file existed here, and nobody looked at the run.
5. `npm publish` — needs your OTP. Traps: a `404 on PUT` = lapsed token (`npm login`);
   `npm view` can 404 for ~2 min after a *successful* publish (confirm with
   `npm access list packages`, don't re-publish).
6. `git tag vX.Y.Z && git push origin vX.Y.Z`; `gh release create vX.Y.Z` with the CHANGELOG notes.
7. Update the `dasasian.com/firebase-structured-logger` page in `dasasian-web`. Only
   `npm publish` and the release need your credentials; an agent drives the rest.
