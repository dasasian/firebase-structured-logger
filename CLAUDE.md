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

Three support modules, not suites themselves:

- `tests/testHelpers.ts` — `assert`, `reportResults`, `readLastEntry(dir)`, `clearLog(dir)`,
  `makeRequest(payload)`. Every suite uses these; don't re-roll them per file.
- `tests/browserStubs.ts` — in-memory `sessionStorage`, a fake `window` with
  `dispatchWindowEvent`/`listenerCount`, a stub `navigator`, and `withFrozenTime`.
  **Import it before the module under test** — `rateLimiter` reads `window` and
  `client/logger` reads `navigator` at module load, so a later stub is too late.
- `tests/logsHelpers.ts` — `runFsl(argv, { cwd, cloud, gcloudOutput, env })` runs `fsl logs`
  against a fake transport and returns stdout, stderr, the exit code and every request the
  transport saw; `cloudEntry()` builds a `gcloud logging read --format json` element.
  The fake project id and bucket are sentinels the suites assert never appear in output.

`labelKeys` drives the client and functions loggers through every scenario that emits a
label and fails on a key `BaseLabels` does not declare. `BaseLabels` is what `fsl logs`
validates `--where labels.<key>` against and what the shipped `.d.ts` tells an agent fsl
writes, so a new label gets a field and a one-line comment there in the same change.
`logsLocal` runs with `FUNCTIONS_EMULATOR=true` because it reads files the emulator branch
really wrote.

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

## Skills and `fsl logs` are for agents

The skills and the CLI are read by a coding agent far more often than by a person, and
they are designed for that reader.

**Facts live in the package; skills hold only steps.** `install-skills` copies a skill
into the app, and the copy does not change when the app updates fsl — POUR5 ran a copy
that still taught `bc.nav` for months. So what fsl can do is in `CAPABILITIES.md`, which
ships in the package and always matches the installed version: for each capability, what
it gives, when it fits, how to add it, and the mistakes to avoid. A skill says how to
work (read the file, read the code, propose, stop) and names nothing that a release can
change. The one thing a stale copy can still get wrong is its own steps, so
`install-skills` stamps `fsl-version` into the frontmatter and doctor reports
`skill-out-of-date` when it differs from `node_modules` — a fixed-format file, within
doctor's rule. Labels an app adds are not in `CAPABILITIES.md`: `fsl logs schema` reads
them from the logs, and an agent reads `AppLabels` and the `labels` arguments in the
app's own code for what it *could* write.

**`/fsl-review` proposes and stops.** It reads `CAPABILITIES.md` and the code in the
scope, and says how fsl could best serve that code. No levels, no fixed output shape,
no `file:line` quota: the user trims the proposal, and what happens next — edits, issues,
subagents — is an ordinary request to their agent, not the skill's business. It runs
`fsl doctor` only when the scope is the whole project; doctor checks the setup, and the
setup has nothing to say about `src/checkout`.

**`fsl logs` is flags named after SQL clauses, never a SQL string.** An agent writes
`--where labels.screen=Checkout --group-by labels.screen` reliably; a single
`"SELECT ... WHERE severity='ERROR'"` needs nested quotes, and one extra shell quoting
layer is the most common way an agent's command fails. Flags are also checkable one at a
time, so an unknown field is an error that names the valid ones and shows an example —
agents invent flags, and the error is where they learn. Output is JSONL, `--select` is the
field mask, `--limit` is 100 by default and 1000 at most, and a cut result says on stderr
how many more there were and how to narrow. The transport is `gcloud logging read`:
every path to Cloud Logging needs `gcloud` for ADC anyway, so a Google library would add
install weight for 1.5 seconds. The transport is one function behind the filter builder,
so `@google-cloud/logging` can replace it later without touching a flag. The query
processor and the local-file reader are the ones from `firebase-mcp-server`, copied, not
shared as a package: two users do not justify a third repo. Group by, distinct and
aggregates stay because they are what lets an agent answer "which screen?" in ten lines
instead of five thousand; `dist/tools` never reaches an app's bundle, so its size is
not a cost.

**`fsl logs` sends a condition to the server only when it surely means the same there.**
A label key nobody has confirmed (not in `BaseLabels`, `schema.json` or the entries read)
stays client-side: a typo sent to Cloud Logging returns zero entries and leaves nothing to
compare the key against, and the "Did you mean" error would never fire. `gcloud logging read`
signs in with `gcloud auth login`, not application-default credentials. The bucket for
`attachments` comes from `--bucket` or `FIREBASE_STORAGE_BUCKET`, the variable
`upload-sourcemaps` reads: `firebase.json` holds no bucket name, and doctor's rule is to
read only what a file's fixed format says.

**`fsl logs schema` keeps two kinds of knowledge apart.** `fromLogs` is what the logs
show — keys, counts, up to three sample values — and `--refresh` rewrites it. `fromCode`
is what an agent found by reading the app, added with `--add name [meaning]`, and
`--refresh` leaves it alone. Samples are skipped for `userId` and for any app-added key whose name
contains `email`, `name` or `phone`, so the file can be pasted into an issue; keys in
`BASE_LABEL_KEYS` other than `userId` are fsl's own and keep theirs (`functionName` is a
code name, not a person's). The cache is `.fsl-logs/schema.json`, per machine, and ignored
by git because every folder fsl creates for logs holds a `.gitignore` of `*`
(`makeSelfIgnoringFolder`, node-only, never overwrites): apps that skip the README's old
step would otherwise commit dev logs and downloaded attachments, which can hold user data.
The file lives in `src/shared` but imports `fs`, so nothing under `src/client` may import it.

**`install-skills` asks before it removes a skill**, and `--force` answers yes. It
removes only skills this package used to ship (`logs`, `query-logs`), never anything an
app wrote itself.

## Tests run from a fresh clone

Everything in `npm test` and `npm run smoke:install` must run for someone who has just
cloned the repo and run `npm install` — no Google Cloud project, no `.env` files, no
installs in `smoke/`. Doctor's tests build small fake projects in temp folders rather
than pointing at `smoke/functions` or `smoke/cloudrun`, which depend on the maintainer's
private smoke setup. Only `npm run smoke` needs a real project.

## Where the user is — one way in for each kind of place

A page with a URL change is navigation (`enableNavigation`); a page without one is
`navigatedTo`; anything inside or on top of a page is a view (`enableViews()` and
`data-fsl-view` markup), a label and never a breadcrumb; what the user did is `bc.action` or markup
(`data-fsl-action`, #52). Each produces one breadcrumb or label, never two for the same
event — that is why `bc.nav` and `setScreen` are ignored once navigation is on.
`labelsFor` customises the default `history` wrapper only. A router adapter
(`/client/navigation/vue-router`, `/client/navigation/react-router`) is a second source
of the same event, not a `labelsFor`: it listens to the router instead of wrapping
`history`, because the router knows the pattern and name and `pushState` does not. Its
one option, `adjust`, edits the router's answer. Only one source runs — the adapter wins
over `enableNavigation()` with one warning, and a second adapter call stops the first.

The adapters type the router structurally and have no peer dependency: they read
`router.subscribe` / `state.matches` (React Router data router, 6.4+ and 7) and
`afterEach` / `currentRoute` (Vue Router 4). The rules that keep one change one crumb:
React records the first page only once `router.state.initialized` is true — before
that, matches exist but loaders have not run, so a first-load redirect would record a
page nobody saw — and after that only when `location.key` changes, so a redirect
collapses to its final page; `route` is joined from the route configs, so it never holds the `basename`, while
`path` (`location.pathname`) does; Vue skips a navigation with a `failure` and
anything before the first real match (`START_LOCATION`), and uses `to.path`, never
`fullPath`. Tests drive real routers in memory — `createMemoryRouter`, and
`createRouter` with `createMemoryHistory` — with both React Router majors installed
through npm aliases.

## Views are read when an entry is written

`/client/views` keeps no state about what is open: no listeners, no observers, no
open/close calls. When an entry is built, the core asks the reader that
`enableViews()` registered through `setViewReader()` in `breadcrumbs.ts` — a named
setter, not a general "extra labels" hook, so a later helper cannot silently replace it.
The reader joins the names of visible `[data-fsl-view]` marks in page order;
visibility is `checkVisibility()` with `getClientRects()` as the fallback. Repeat
summaries skip it: they are sent later, and the view at send time is not where the
errors happened. jsdom has no layout, so tests stub `checkVisibility` in
`tests/browserStubs.ts`.

## `/testing` is for apps' tests, and asserts what ships

`captureEntries()` is a `logFunction` that keeps what the logger sends — the real
output, after cleaning, size limits and the rate limiter — not a getter of internal
state; a getter would let an app's test pass while the sent entry is wrong.
`resetSession()` is separate from `capture.clear()` on purpose: one resets the
logger's session state, the other the test's list. No core module imports
`/testing`, and nothing in it may need a DOM.

## Optional client helpers are separate entry points

Navigation, and the helpers after it (#51 timing, #58 views, #52 marked actions, #53 network), each
ship as their own subpath — `/client/navigation`, not an `initLogger` option. A bundler
cannot drop code behind a runtime option, and this package is CommonJS, which bundlers
barely trim at all; a separate file that is never imported costs nothing. The core
`/client` must not import a helper — `tests/` bundles `/client` and asserts none of the
helper's code is in it. A helper hands data to the core through a small setter in a core
module (as `screen` does through `breadcrumbs.ts`), never the other way round.

Dynamic `import()` was considered and rejected: in a CommonJS build it compiles to
`require`, so nothing splits, and a late load misses the route changes made before it
arrives.

## Traces report misbehaviour, nothing else

Timing traces (`/client/timing`, `/functions`) exist to explain the slow case. A run that
finishes within its limits sends nothing — no entry, no breadcrumb, no console line —
and there is no sampling or percentile story, on purpose: measuring what is normal is a
monitoring tool's job. A run that was hidden or paused is never judged, because a
browser pausing a page is not the app being slow; the late-tick watchdog exists because
laptop sleep often fires no event. The server judges only when a step or trace ends: no
timers, since the CPU can be throttled after a response.

## Wrapping browser APIs

Navigation tracking wraps `history.pushState` and `replaceState` — browsers send no
event when a single-page app changes route, so there is no other way to see it. That is
patching someone else's page, so it is opt-in (`enableNavigation()`), and the wrapper must
call the original with the same arguments and `this` and return its result, wrap once
however often `initLogger` runs, and leave alone any wrapper another tool installed
before or after it. Prefer observing to wrapping wherever the browser offers it
(`popstate`, `PerformanceObserver`); a wrapper is the exception that needs a reason.

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
