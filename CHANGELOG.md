# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`withLogging` wraps `onSchedule` and `onTaskDispatched`** as well as `onCall`: pass `ScheduledEvent` or `Request<Data>` as the second type argument. `userId` comes from `auth.uid` when the event has one. `CAPABILITIES.md` no longer lists `onRequest(`, which `withLogging` cannot wrap.
- **`fsl logs`** reads production logs through `gcloud logging read`, or `.fsl-logs/` with `--local`, with flags named after SQL clauses (`--where`, `--select`, `--group-by`, `--order-by`, `--limit`, `--distinct`, `--since`, `--repeats`). One JSON entry per line; a field or flag it does not know is an error that names the valid ones.
- **`fsl logs schema`** lists every label in the logs with counts and sample values (none for `userId` or keys containing `email`, `name`, `phone`), and keeps labels your code writes with `--add`. **`fsl logs attachments <logId>`** downloads an entry's files.
- **The logs folder ignores itself in git.** Every folder fsl creates for logs (`logLocalDir`, `.fsl-logs/`) gets a `.gitignore` of `*` unless one exists, so the README's `.gitignore` step is gone. `fsl logs` now says on stderr when 0 entries matched, and `fsl logs schema` keeps samples for fsl's own `functionName`.
- **`/fsl-logs` skill** for coding agents, installed by `fsl install-skills`.
- **`/fsl-review [scope]` skill** and **`CAPABILITIES.md`**. The skill reads `CAPABILITIES.md` from the installed package and the code in the scope (the app, a folder or a file), and proposes how fsl could best serve that code. It proposes and stops. `CAPABILITIES.md` ships in the package: for each capability, what it gives, the code signals it fits, how to add it, and the mistakes to avoid.
- **`fsl install-skills` writes `fsl-version`** (the package version) into each skill's frontmatter, and asks before removing an installed `logs` or `query-logs`; `--force` answers yes.
- **`fsl doctor` finding `skill-out-of-date`** (warning): a skill's `fsl-version` differs from the fsl running doctor. Skills without `fsl-version` are skipped.
- **`BaseLabels`** declares every label fsl writes, each with a one-line comment: `repeatKey`, `repeatOf`, `repeatCount`, `firstSeen`, `lastSeen`, `sentLate`, `truncated`, `hasAttachments`, `logId`, `functionName`, `trace`, `run`, `slow`, `step`, `feedback`.

- **Errors a framework catches are logged where it catches them.** `createRoot(el, { onCaughtError: handleReactError })` and `app.config.errorHandler = handleVueError` (new) send React and Vue render errors, `handleReactError` now accepts what React 19 passes, and the React Router and Vue Router adapters log their router's errors on their own (`errorType` `RouteError`: a loader or action error or 5xx response as `ERROR`, a 4xx response as `WARNING`; a guard that throws or a lazy route that fails to load as `ERROR`). The function an adapter returns stops its error listener too.
- **`/testing` `capture.settled()`** waits for every send already started, so a test can read `entries` after a log call with attachments or after a repeat summary; log methods still return `void`.

### Fixed

- **`fsl doctor` `maps-published`** is an error only when nothing removes the maps before a deploy: no `fsl upload-sourcemaps` in a `package.json` script or hosting `predeploy`, and no `**/*.map` in hosting `ignore`. A plain `npm run build` no longer fails doctor.
- **`fsl --help`, `-h` and `help`, and `--help` or `-h` after any command, print the usage and exit 0** instead of running the command (`install-skills --help` ran the install). **`fsl install-skills` with no terminal and no `--force`** no longer answers N for you: it asks nothing, installs what needs no answer, names on stderr what it left and the `--force` that does it, and exits 1.
- **`/fsl-review` and `CAPABILITIES.md`** no longer flag a `data-fsl-view` value from a fixed set of code names, no longer raise `maxInstances` from code alone, and name both versions when a whole-app review finds two installs that differ.

### Removed

- **`/query-logs` skill**, which depended on `firebase-mcp-server`. `fsl install-skills` offers to remove an installed copy.
- **`/logs` skill**, replaced by `/fsl-review`: it carried facts in its own copy, which went stale. `fsl install-skills` offers to remove an installed copy.

## [1.3.0] — 2026-10-07

Where the user is, told by the router and the page. A router adapter takes `route` and
`screen` from React Router or Vue Router's own patterns and names, so a redirect on first
load is one breadcrumb and a `:param` route is one page. `data-fsl-view` marks name the
tabs, steps and dialogs on screen, and every entry carries them as a `view` label. And
`/testing` lets an app assert what it logs, with the real entries the logger sends.

### Added

- **`labelsFor` and `defaultLabelsFor`** on `/client/navigation`: one function names a page's `route`, `screen` and `path`, and its answer is used exactly as returned. It replaces `routeFor`, `cleanPath` and `path: false`.
- **`navigatedTo(screen, { route?, path? })`** for apps whose screens change without the URL changing — the same breadcrumb and labels as automatic navigation.
- **`bc.handledError`** — the clearer name for an error your code handled and did not log.
- **`/testing`:** `captureEntries()` keeps every entry the logger sends, for your own tests, and `resetSession()` starts each test with an empty trail and a full budget.
- **`fsl doctor` warns `logs-inside-functions-source`** when local log files sit inside the Functions source folder.
- **Views:** `enableViews()` from `/client/views`, and `data-fsl-view="name"` in your markup. Every browser entry carries a `view` label naming the marked tabs, steps and dialogs visible when it was written, joined with ` › `.
- **Router adapters:** `enableVueRouterNavigation(router)` from `/client/navigation/vue-router` and `enableReactRouterNavigation(router)` from `/client/navigation/react-router`. They take `route` and `screen` from the router's own patterns and names instead of guessing from the path. One option, `adjust`, edits the labels. Neither router is a dependency.

### Changed

- **One structured `nav` breadcrumb per page change:** `name` is the screen (or the route), `data` holds `route` and `path`. In 1.1–1.2 the name was the path. With navigation on, `bc.nav` and `setScreen` no longer add a second breadcrumb for the same change.
- **With navigation on, the `screen` label comes from navigation, not `setScreen`.** An app that called both now sees navigation's screen on every entry, and repeat counting groups errors by that screen too.

### Fixed

- **React Router: a redirect on first load records one breadcrumb,** for the page it ends on. It recorded the starting page too.
- **The README's local log folder is now `.fsl-logs/` at the repo root.** Inside `functions/`, every entry restarted the emulator, which rotated the file and deleted entries within seconds.

### Deprecated

- `enableNavigation({ routeFor })`, `({ cleanPath })`, `({ path: false })` → `labelsFor`; the `routeSource` label; `bc.nav` and `setScreen` → navigation or `navigatedTo`; `bc.error` → `bc.handledError`. Each warns once where code can, and is removed in 2.0 (#56).

## [1.2.0] — 2026-10-04

Timing traces. Some failures never throw: a loading screen waits on eight pieces, one of
them takes thirty seconds, and the logs say nothing. A trace reports exactly that — a
step or a whole flow that ran past its limit, or never finished — and nothing when it
ran in time. Your code names the steps; the limits live in one setup call.

### Added

- **Timing traces** — `trace(name, fn)` / `startTrace(name)` with `.step()`, from `/client/timing` and `/functions`, and one `configureTraces({...})` holding every limit. A run that crosses a limit sends one `WARNING`, while it is still running, with the steps done and still waiting; a run in time sends nothing. Browser runs that were hidden or paused (a laptop sleeping, a frozen tab) are not judged. Steps are standard `performance.measure` entries underneath.

### Fixed

- **`npm publish` no longer rewrites `bin`.** It was declared as `./dist/tools/index.js`, which npm normalised with a warning on every publish.

## [1.1.0] — 2026-10-04

Navigation, automatically. One import, and every route change in a single-page app
becomes a breadcrumb, and every entry says which route and which real page it came
from. It is its own entry point, so an app that does not import it ships none of it —
the first of the optional helpers built that way.

### Added

- **Navigation, automatically** — `enableNavigation()` from the new `/client/navigation` entry point records every route change as a breadcrumb and labels each entry with `route` (the pattern, `/orders/:id/items`), `path` (the real path) and `routeSource`. `screen` keeps its meaning and falls back to `route` when unset. An app that does not import it ships none of it; the query string and non-route fragments never leave the browser; `routeFor`, `cleanPath` and `path: false` for apps that need them.

## [1.0.0] — 2026-09-28

The API is stable. From here, a breaking change means 2.0. Before freezing it, every
public name was reviewed and eight were renamed; the old ones keep working through 1.x
with a one-time warning, so upgrading breaks nothing. New in 1.0 is `fsl doctor`, which
reads a setup off disk and says what will go wrong before it does. Also here: warnings
can no longer spend the error reserve, one copy of Storage whatever firebase-admin a
project has, TypeScript 6, and Node 22 and 24 tested — Node 20 reached end of life.

### Added

- **`fsl doctor`** checks the setup from disk — no network, no credentials — and prints how it will behave plus any findings, as text or `--json`. It reports only facts it can read from files, never guesses from source code. Errors fail with exit code 1, `--strict` fails on warnings too, and a check it could not run always fails. `--backend`/`--dist` point it at a setup with no `firebase.json`.

### Fixed

- **Warnings could spend the error reserve.** The log limit recharges continuously, so its count is almost never a whole number, and the reserve check `available <= reserve` let a warning through at, say, 1.02 with a reserve of 1 — spending the room kept for the next crash. It now asks whether spending one log would dip into the reserve. Found as a CI-only test flake: on a fast machine the calls share one millisecond and the count stays whole.

### Changed

- **Node 20 is no longer tested.** It reached end of life on 2026-04-30. `engines` already required Node 22, so nothing changes for a supported install; CI now runs Node 22 and 24, the current LTS.
- **`@google-cloud/storage` is accepted as `^7.19.0 || ^8.1.0`** (was `^7.0.0`). firebase-admin 14.5 brings Storage 8 and 13.x brings 7; with the old range a project on the newest firebase-admin installed two copies. Now npm reuses the one already there. Both majors are exercised by `npm run smoke:install`, which CI now runs.
- **Built with TypeScript 6** (was 5.9), with `module`/`moduleResolution: node16`. The published JavaScript is byte-identical and the `.d.ts` unchanged; a consumer on TypeScript 5.9, or resolving with `node16` or `bundler`, compiles against it as before.

### Deprecated

- **Eight names, renamed before the 1.0 API freeze.** `minLogLevel` → `minSeverity` (the server already used it, and so does Cloud Logging); `bucketName` → `bucket` (every other bucket option already was); `rateLimitOptions.sessionLimit` → `burstLimit`, `refillPerMinute` → `rechargeSecondsPerLog`, and `errorReserve` (a share) → `reservedForErrors` (a count), because the limit now recharges one log at a time rather than lasting a session; type `ClientLogRequest` → `LogRequest`; `triggerTestLog()` → `sendTestLog()`; the CLI flag `fsl upload-sourcemaps --functions` → `--backend`. Every old name still works in 1.x with a one-time console warning, and is removed in 2.0. The README's Reference has the full table.

## [0.9.0] — 2026-09-27

The logger no longer goes quiet when things get bad. A long session used to spend its
50-log budget by mid-morning and send nothing after, a flood of one error hid everything
behind it, and an entry past 100 KiB arrived as broken text. Now the budget refills and
keeps a fifth for errors, repeats are counted and sent as a summary — on the next visit
if the tab closed first — and a big entry is shortened with its full copy in Storage.
Each was checked live, and the live checks found two bugs the unit tests had passed.

### Changed

- **The client's log budget refills, keeps an error reserve, and turns repeats into summaries instead of dropping them (#40).** The budget was 50 logs per page load, cleared on `beforeunload`, with every severity spending from the same pool and every duplicate past 3 copies simply dropped. Now: the budget refills at `refillPerMinute` (default 1/min) and survives a reload in `sessionStorage` — `beforeunload` no longer resets it; the last `errorReserve` share (default 20%) can only be spent by `ERROR` and above, by rank (`SEVERITY_ORDER`), so `CRITICAL`, `ALERT` and `EMERGENCY` — new severities, see below — may spend it too; and after `duplicateLimit` full copies, further occurrences are counted rather than dropped and sent as one `WARNING` summary — hourly, when the tab is hidden, and once at startup for anything a previous visit left queued — carrying `repeatOf`, `repeatCount`, `firstSeen`, `lastSeen`, and `appId`/`releaseId`/`userId`/`screen`/`errorType` recovered from the signature itself rather than a second stored copy of them. The browser has no server `logId` for the first copy, so `repeatOf` instead points at a client-side `labels.repeatKey` that every full copy carries. The per-signature map is capped at 200 entries (evicting the oldest with nothing pending first) so a flood of distinct messages cannot grow it without bound. Unsent summaries wait in `localStorage` (survives the tab closing), capped at `maxPendingSummaries`, expired after `summaryMaxAgeDays`, marked `sentLate="true"` when a later visit sends them, and removed from the queue only once their send has actually succeeded — a failed send (offline, or the tab closing right after) leaves it queued for the next flush or visit to retry, never twice. All seven numbers are configurable via `rateLimitOptions`. The three console messages a dropped or counted log produces changed to match. See README, "Volume controls".
- **`writeLog`'s production branch honours a client-supplied `timestamp`, but only on a repeat summary.** `LogPayload` gains an optional `timestamp`; it is written into the entry only when `labels.repeatCount` is present and the value is within the last 8 days and no more than 5 minutes in the future — so a summary is timestamped at `lastSeen`, not at send time, and anything else keeps Cloud Logging's own ingestion time.

### Fixed

- **An entry over 100 KiB arrived broken, with no severity or labels.** Cloud Functions and Cloud Run both cut a stdout/stderr log line at exactly 102,400 bytes — measured live. `writeLog`'s production branch now measures the finished entry and, past 90 KiB, shortens it (breadcrumb data, then other context, then the tail of a long stack, then long text fields, then oversized label values — `severity`, labels, trace and `serviceContext` are never touched) before writing, saves the full original to Cloud Storage as `fsl-overflow.json` when a bucket is available, and labels the entry `truncated="true"` (issue #21).

### Documentation

- **`/query-logs` counts repeats.** The shipped skill now adds `repeatCount` from the summaries to the full copies when asked how often something happened, and reads `fsl-overflow.json` for a shortened entry. The README's Querying table gains the `truncated`, `repeatKey`/`repeatOf` and `sentLate` filters.
- **The server half has to run on Google Cloud.** 0.8.0's README said "any Node server". Entries go to stdout, which reaches Cloud Logging only on Cloud Functions, Cloud Run, GKE, App Engine, or Compute Engine with the Ops Agent — elsewhere they print and go nowhere.

## [0.8.0] — 2026-09-24

Firebase is optional now, and that is tested rather than claimed. 0.7.0 added
`createHttpLogHandler` for backends that are not Cloud Functions, but on one — Cloud
Run with no Firebase packages — `/functions` failed on `require`, and once loaded it
dropped every trace id. Both are fixed, and the smoke run now includes exactly that
service. Thanks to [Vivek Rao](https://github.com/vivekvrao), whose adoption found
the first of it.

### Fixed

- **`/functions` could not be loaded without `firebase-functions` installed**, which made `createHttpLogHandler` (0.7.0) unusable on the backend it was written for. `logger.ts` imported `firebase-functions/logger` at module load and `logHandler.ts` imported `onCall` the same way, so a Cloud Run service without it failed on `require` before reaching the HTTP handler. Both are optional peers now, loaded lazily. Where `firebase-functions` is installed nothing changes — its `write()` still attaches each trigger's trace id. Where it is not, entries are written as one JSON line each (WARNING and above to stderr, like `write()`), and the trace comes from the request headers. Reported and fixed by [Vivek Rao](https://github.com/vivekvrao) in #39.
- **`/functions` could not be loaded without `firebase-admin` either.** `sourceMapCache.ts` imported `firebase-admin/storage` at module load, for a bucket only older-release maps and attachments need. Storage now resolves on first use, down a chain: `firebase-admin` if installed (unchanged), else `@google-cloud/storage` with the bucket you named, else no Storage — current-release embedded maps still resolve, older releases stay minified, attachments are dropped with the entry kept, and one warning says which. `hasAttachments` is no longer set on an entry whose attachments had nowhere to go. Found by `npm run smoke:install`, a new check that installs the packed tarball with no optional peers.
- **Trace ids were never written on Cloud Run.** 0.7.0 built `projects/<id>/traces/<trace>` from `GCLOUD_PROJECT` or `GOOGLE_CLOUD_PROJECT`, and Cloud Run sets neither — so behind `createHttpLogHandler` the trace was silently dropped. On Cloud Run the project now comes from the metadata server, once, the way Google's own Cloud Run sample does. Without a project the bare trace id is written, which is still a valid trace but does not meet Cloud Run's request log in "show entries for this trace"; the smoke run checks that the two do meet.
- **The client's production floor was never applied in a browser.** `defaultMinLevel` guarded on `typeof process`, which is undefined in every browser even though bundlers fold `process.env.NODE_ENV` to a literal — so the folded branch was unreachable and every browser build defaulted to `DEBUG` in production. Seen in a real Vite bundle as `typeof process<"u"?"WARNING":"DEBUG"`. The guard is gone; a runtime with neither the fold nor `process` throws on the read and is caught.

### Documentation

- **Without Firebase.** The README says what is true now: the browser half has no Firebase dependency, and the server half runs on Cloud Functions, Cloud Run or any Node server. A new section covers what changes without Firebase — `authorize`, naming a bucket, and which tools are Cloud Functions only.
- A Hono adapter next to the Express one. `createHttpLogHandler` takes Node's request and response shapes, and Hono wraps them.
- Volume controls: a Vite `define: { 'process.env': {} }` makes the client's production floor `DEBUG`. Pass `minLogLevel`.

## [0.7.0] — 2026-09-01

Errors group now. Not because this package learned to fingerprint them, but because Google
Cloud already runs an error tracker in your project and it could not see ours.

### Added

- **Cloud Error Reporting shape.** Production error entries carry `stack_trace` at the top level and a `serviceContext` naming your `appId` and release. Error Reporting reads Cloud Logging and groups by exception type plus the five top-most frames — with occurrence counts, an Open/Acknowledged/Resolved/Muted state, notifications, and an issue-tracker link — none of it ours to build or run, and none of it leaving your project.

  It groups on those top frames, which is why it does nothing for almost every web app: they read `app-4f2a.js:1:98432` and change every release. **We resolve them before the entry is written**, so yours group. Verified live: two errors with different messages from one source location share a group id, attributed to the `appId` rather than to the function that wrote them, stable across releases. Warnings and feedback are deliberately excluded — an issue is something a person has to resolve, and neither of those is a bug.

- **`createHttpLogHandler`** — receive client logs over plain HTTP, for a backend that is not Cloud Functions. Reads `method`, `headers` and a parsed `body` and writes through `statusCode`/`setHeader`/`end`, so Express, Fastify's compat layer and a raw server all satisfy it with no dependency added. The client was already portable: `logFunction` is any `(payload) => Promise<unknown>`, and `httpsCallable()` merely happens to fit.

  `authorize` is **required and has no default**, because the honest default does not exist — a callable gets Firebase's token check for free, an HTTP endpoint gets nothing, and an open one writes to your Cloud Logging bill on anyone's say-so. Opening it deliberately is spelled `'unauthenticated'` at the call site. It is a gate, not an identity check: the handler never reads `request.auth`, and a gate that throws counts as a rejection.

- **Trace ids outside Cloud Functions.** `firebase-functions` attaches `logging.googleapis.com/trace` from a store it populates inside its own request wrapper, so on Cloud Run nothing was attached and a request's entries did not correlate — silently. The HTTP handler now reads `X-Cloud-Trace-Context` or W3C `traceparent` itself. A malformed header yields nothing rather than a guess: Cloud Logging rejects an invalid trace resource name, which costs the whole entry.

- **Configurable Storage buckets and prefixes.** `createClientLogFunction({ sourceMaps: { bucket, prefix } })` is genuinely per-handler; `configureAttachments({ bucket, prefix })` is a separate global call, because the attachment upload happens in `writeLog` — reached from every log call, including ones inside handlers that never touch `createClientLogFunction` — so a field on the handler would let a second one silently retarget the first's attachments.

  Every default is the previous behaviour, so nothing changes for a deploy that does not opt in. Worth opting in where user content needs its own region for residency, its own retention policy, or different IAM from your source maps — none of which a prefix can arrange.

- **`fsl upload-sourcemaps` runs without a bucket.** With `--embed-sourcemaps` alone it embeds the current release and uploads nothing, which is the whole flow for a backend that has no bucket. Only the deployed release can then be symbolicated. Given neither a bucket nor an embed it now refuses outright rather than running, since that would delete the maps and produce nothing.

- **`fsl upload-sourcemaps --prefix`**, the writer half of the configurable Storage prefix.

### Changed

**Breaking: a production error's stack moved from `jsonPayload.error.stack` to top-level `stack_trace`.** One copy, not two — the stack is the largest field in an entry capped at 256 KB. Anything reading `error.stack` off a production error entry reads `stack_trace` now. The rest of the `error` object — `message`, `name`, `cause` — is unchanged, and entries below `ERROR`, or marked as feedback, keep their stack where it was.

**`createClientLogHandler` is no longer Firebase-shaped.** It takes `{ data: LogPayload }`, the minimum it reads, and throws `ClientLogError` rather than `HttpsError`. `createClientLogFunction` converts at the Firebase boundary, so a callable client sees exactly the error it saw before; only a caller wrapping the bare handler themselves is affected.

**Every Storage path is defined once**, in `src/shared/paths.ts`. Each source-map path previously existed twice — a writer in `/tools`, a reader in `/functions` — as independent literals with nothing enforcing that they matched, and when they disagree symbolication does not fail, it returns minified frames. Two things stopped being coincidences: the `.map` suffix, which the writer and reader agreed on only because a basename happened to end in it, and separators, since a Storage object name built with `path.join` is a different object on Windows.

**A misconfigured source-map lookup says so.** When nothing resolves — wrong bucket, wrong prefix, a release never uploaded, a missing `fsl` step — the function warns once per release naming both paths it tried. A prefix mismatch is only obvious once you can see the two strings.

### Fixed

- **`fsl` never wrote the `.release` marker, so the release check had never run.** The constant was declared, exported and used by nothing; the reader hardcoded its own copy. Every stack was symbolicated with the currently embedded maps whatever release it came from — precisely the failure the marker exists to prevent — and the fallback warning was unreachable code. Narrow in practice, since Vite content-hashes bundle filenames, but real for any build with stable names. The tests missed it because they wrote the marker themselves before exercising the reader.

- **A prefix with a trailing slash addressed a different object.** `'fsl/'` yielded `fsl//r7/app.js.map`, which is not `fsl/r7/app.js.map` — Storage keys are opaque strings and the double slash is not collapsed, so a slash typed out of habit would have split writer from reader silently.

### Documentation

The README is reorganised around what you get rather than how the machine is built. `How it works` now precedes setup, so the Cloud Function is explained before you are asked to deploy one, and its diagram shows both doors into the stream. Setup is two paths, browser errors and Cloud Functions logging — backend setup previously did not exist as a path at all. New sections cover the eleven fields that arrive without being asked for, the five gates that silently drop a log, attachments as the way past the 256 KB entry limit, and querying. `What this is not` is rewritten, since it claimed there was no grouping.

`skills/query-logs` had `severity=ERROR` on its flagship query, which keeps the crash and throws away the sequence that led to it. The sequential read is now the headline example.

### Internal

`tests/` and `smoke/` are typechecked for the first time, under a second config, and the smoke harness no longer uses `any`. Neither was checked before, which is how a read of `entry.metadata.errorGroups` — a field the Logging client does not surface — reached a live run and reported, wrongly, that Error Reporting had grouped nothing.

## [0.6.0] - 2026-08-23

### Added

- **`sendFeedback(text, extras?)`** — capture what error tracking structurally cannot see. A button that does nothing, a wrong total, the wrong data rendered: none of them throw, so none are logged. Feedback captures that class, and the breadcrumb trail already in memory turns *"the discount didn't apply"* from a complaint into a reproduction. Headless — the app owns the UI. Carries the same labels and breadcrumbs as any log, plus an optional screenshot.
- **`NOTICE` severity** — ranks between `INFO` and `WARNING`, matching Cloud Logging's own ordering. Feedback from a person outranks routine status without being a warning about system health, and any existing `severity >= WARNING` alert ignores it with no configuration. **This widens the public `LogSeverity` union**, which is breaking for exhaustive `switch` statements and `Record<LogSeverity, T>` in consumer code.

### Changed

- **The 5-minute breadcrumb cutoff now applies when reading, not only when writing.** It previously lapsed exactly when nothing was happening: a user who went idle for ten minutes and then hit an error shipped a trail of ten-minute-old steps presented as the path that led there.
- **Every log now carries the full breadcrumb trail (up to 50 entries), not the newest 20.** The trail already retained 50; the send path asked for 20, so 30 were kept in memory that nothing could read. Error and feedback payloads grow by roughly 3 KB, or ~2% of Cloud Logging's 256 KB entry limit.

### Removed

**Breaking: `initRequestLogger` is gone. Use `withLogging`.** It bound the request scope with `AsyncLocalStorage.enterWith()`, which is never unwound, so a request's labels outlived the request — a later handler that did *not* call it inherited whichever user last touched the warm instance. Deprecated in 0.5.0 with a warning naming the leak. `withLogging` binds with `run()`, which restores the previous context when the handler settles, including on a throw.

**Breaking: `setActiveActivity` and `BaseLabels.activity` are gone.** `activity` was ambient state with no natural end — nothing cleared it automatically, so a forgotten one contaminated the rest of the session, and because it fed the dedup signature a stale value distorted which errors were suppressed. A wrong signal in a filtering rule is worse than a missing one. `screen` looks similar but is self-correcting: the next `setScreen()` overwrites it. Nothing set `activity` in practice, so removing it from the signature changes no behaviour — the segment was always empty. See #29 for restoring path discrimination from breadcrumbs, which are derived rather than manually maintained and therefore cannot go stale.

### Fixed

- **An unrecognised severity crashed `writeLog` and destroyed the entry** — both dispatch paths look the value up in a fixed table (`CONSOLE_FN` in emulator mode, `firebase-functions`' own `CONSOLE_SEVERITY` inside `ffWrite`), and a miss resolves to `undefined`; calling it throws, `Logger.send()`'s catch swallows it, and the entry disappears with no diagnostic. It also slipped past the min-severity floor, since `SEVERITY_ORDER[unknown]` is `undefined` and `undefined > n` is `false`. `writeLog` is exported, so a caller could reach it with a value read from config, crossing a type boundary, or from plain JavaScript. Unknown severities are now written as `ERROR` with a warning naming the bad value — an entry arriving loud beats one vanishing quietly.

## [0.5.0] — 2026-08-23

### Added

- **`withLogging(options, handler)`** — the correct way to scope a request logger. Wraps an `onCall` handler, binds the request's labels with `AsyncLocalStorage.run()`, and unwinds when the handler settles. Options may be an object or a function of the request, for labels derived from the payload.

### Deprecated

- **`initRequestLogger` — removed in 0.6.0.** It binds with `enterWith()`, which is never unwound, so a request's labels outlive the request. A later handler that does *not* call it — a scheduled function, a Firestore or Storage trigger, or anything relying on `getLogger()`'s anonymous fallback — inherits whichever user last touched the warm instance. Reproduced: a handler that never called it logged `userId: alice` from the previous request. Handlers that all call it are unaffected; the hazard is the ones that don't. It still works, and now warns once per function name explaining the leak.

### Fixed

- **The source map cache was unbounded** — it grows with releases × bundles and lives for the instance's lifetime, so a long-running Cloud Function serving errors from several releases accumulated parsed maps without limit. At ~580KB per map (or ~2.2MB for maps uploaded before 0.4.0), that is a plausible out-of-memory on the 256MB default, presenting as random instance crashes rather than a logging fault. It is now bounded at 64MB with LRU eviction. Negative entries — a confirmed "no map for this release" — are exempt: they cost nothing and each one prevents a repeated Storage round-trip on the per-error path. The embedded cache stays unbounded on purpose; it only ever holds the deployed release's maps.
- **An old release's stack could be symbolicated with the current release's map** — the embedded lookup was keyed on filename alone and checked before Storage, so a stack from release `v1` naming a bundle that still exists in `v2` resolved against `v2`'s map. The result was a confident, plausible-looking, wrong file and line — worse than no symbolication, because nothing signals it. Content-hashed bundle filenames made this safe in practice, but that safety was incidental and unchecked. `fsl upload-sourcemaps --embed-sourcemaps` now records which release it embedded, and Storage is preferred **only when it actually has a better map**: a matching release still uses the embedded copy with no network call, and a mismatch with nothing in Storage falls back to the embedded map with a warning. Apps that never version a release are unaffected — they keep resolving exactly as before.
- **An unreadable attachment dropped the entire log entry** — message, labels, breadcrumbs and all, not just the attachment. Attachment conversion shared a `try` with the send, so a `FileReader` failure meant `logFunction` was never called. A `File` from `<input type="file">` genuinely raises `NotReadableError` when it is moved or deleted between selection and submit. Each attachment now converts in its own `try`: failures are omitted, the rest are kept, and the entry is sent regardless. The names that failed are recorded in an `attachmentsFailed` label so their absence is not a mystery. The misleading `Failed to send log` message no longer covers this case.

- **`fsl upload-sourcemaps` exited 0 when the Storage upload failed** — with `--embed-sourcemaps`, a failed upload was warned about and then swallowed. Deploy scripts are `&&` chains, so `firebase deploy` proceeded and the only signal was a warning scrolling past in CI. It now exits **3** (`EXIT_UPLOAD_FAILED_BUT_EMBEDDED`), distinct from a hard failure so a deploy chain can opt to continue with `|| [ $? -eq 3 ]` rather than facing an all-or-nothing choice.
- **The failed-upload warning described the wrong releases** — it said "previous releases will not be symbolicated". Previous releases are unaffected; their maps reached Storage on earlier runs. The release at risk is the *current* one: its maps never arrived, and the embedded copy in `sourcemaps/current/` is replaced by the next deploy. The message now says that.

## [0.4.0] — 2026-08-23

### Fixed

- **Labels were not queryable in Cloud Logging** — every documented filter returned nothing. `labels.errorType="fsl-verify"` matched zero entries because a plain `labels` key is not one of the fields Cloud Logging promotes to `LogEntry.labels`; it landed in `jsonPayload.labels` instead. Labels are now emitted under `logging.googleapis.com/labels`, which is the field name Cloud Logging recognises. Everything `skills/query-logs/SKILL.md` documents — `labels.userId`, `labels.screen`, `labels.releaseId`, `labels.errorCategory`, `labels.hasAttachments` — works as written for the first time. Confirmed against real Cloud Logging, not just the emitted bytes.

### Removed

- **`fsl pack` and `fsl pack-restore`** — they existed only to vendor a tarball into `functions/` so `firebase deploy` could bundle an unreleased local build. They had also been broken since the move to the `@dasasian` scope: `findFslDep` looked up the unscoped dependency key, so the command exited 1 on any correctly-installed project — after already writing a tarball into the user's `functions/vendor/`. To try an unreleased change in a real deployment, publish a prerelease (`npm publish --tag beta`) and install it; `npm link` covers local work. That tests the published artifact rather than a local build, and rewrites nobody's `package.json`.

### Changed

**`fsl upload-sourcemaps` no longer uploads `sourcesContent`.** Source maps are stripped of it before being written to Storage and before being embedded into `{functionsDir}/sourcemaps/current/`. Symbolication never read it — `originalPositionFor` needs only `sources`, `names` and `mappings` — and it was **74.6%** of a real Vite map (2.23 MB → 580 KB). It also meant a logging tool was shipping your original source code into a Storage bucket. Maps with no `sourcesContent` are passed through byte for byte, and an unparseable map is uploaded unchanged rather than dropped.

## [0.3.0] — 2026-08-23

### Changed

**Node 22 is now the supported floor** (`engines.node: ">=22"`, was `">=18"`). `firebase-admin` 14 requires Node 22, and `/functions` exists to be used alongside it, so `>=18` was only ever true for consumers still on `firebase-admin` 13. Node 18 also reached end-of-life in April 2025 and Google has been retiring the `nodejs18` Cloud Functions runtime. npm warns rather than fails on an `engines` mismatch, so this is a support statement, not a hard gate. CI now runs Node 20 and 22 — 20 as a courtesy check for consumers on `firebase-admin` 13, 22 as the supported floor.

### Fixed

- **Cross-origin script errors were logged as `Error("null")`** — a script loaded cross-origin without CORS has its error withheld by the browser (`event.error === null`), and that null was passed straight through. Every such error produced an identical entry, so they were indistinguishable in Cloud Logging *and* shared one rate-limit signature — after three, the rest were silently suppressed as duplicates. The event's own `message`, `filename`, `lineno` and `colno` are now used, and `errorType` is set to `CrossOriginError` so they are filterable. An unhandled rejection with no reason gets a stated message rather than `Error("undefined")`.

## [0.2.0] — 2026-08-22

### Fixed

- **Errors consumed two units of the session budget instead of one** — `error()` incremented the counter, then `send()` incremented it again, so a configured `sessionLimit` of 50 was really 25 for errors. Verified: one `error()` call left `logCount` at 2. Errors are the logs least safe to drop silently.
- **Source-map bucket was process-wide, not per-handler** — two handlers built with different `bucketName`s silently shared one, whichever was constructed last. App A's maps were sought in app B's bucket, found nothing, and stack traces stayed minified with no error raised. The lookup now takes the bucket explicitly, and the cache key includes it.
- **Built-in labels were rejected on the public log methods** — a consumer declaring `AppLabels` as a type alias could not pass `screen`, `errorType` or any other `BaseLabels` field without a cast: `logger.info('opened', { screen: 'Checkout' })` failed to compile. Widened to `Partial<AppLabels & BaseLabels>`, which is what the payload always accepted.

### Changed

**Breaking: `Logger` is no longer exported as a constructible class.** Construct via `initLogger()`; `Logger<AppLabels>` still works as a type annotation. Nothing in the README ever showed `new Logger(...)`, so most consumers are unaffected.

- **Rate limiting is one atomic operation** — `canLogEvent`/`canLogError` plus `recordLog`/`recordError` collapse into a single `allow(signature?)` that decides and consumes together. Splitting the check from the record across two layers is what produced the double-count and meant an error was tested against the session limit twice. One `sessionStorage` round-trip per log instead of up to six.
- **Duplicate suppression works for any severity** — it was welded to `error()`; a `warning()` firing on every render had no protection. Pass a signature to opt any log in.
- **`Logger` is exported as a type, not a constructible class** — the client logger is a session singleton. Breadcrumbs, current screen, active activity and the rate-limit budget are all session-scoped, so a second instance would share them while appearing independent. Use `initLogger()`; annotate with `Logger<AppLabels>`.

### Removed

- **`ulid` upgraded to 3.x** — verified format-compatible with 2.x: still 26 characters, Crockford base32, ordered across milliseconds. Existing `logId`s and the GCS attachment paths keyed on them are unaffected.
- **Three `as never` casts in `errorHandler.ts`** — they were never load-bearing and disabled type checking entirely at those call sites.

## [0.1.1] — 2026-08-16

### Fixed

- **Error `cause` on the functions logger** — an error built with `new Error(msg, { cause: null })` wrote `"cause": "null"` into the entry as a literal string, while the client logger dropped it. It is now omitted on both sides. The two had drifted because each logger built its own error payload.

### Added

- **Shared severity and error modules** — the severity ranking was declared in the client logger, the functions logger, and the log handler; the error payload was built twice. All of it now comes from `src/shared/severity.ts` and `src/shared/error.ts`, so the two sides cannot drift apart again.
- **Tests for the four untested modules** — `breadcrumbs`, `rateLimiter`, `errorHandler`, and `requestLogger` had no coverage at all. The suite now runs 234 assertions across eight files, including a parity check that the client and functions loggers build an identical error payload.
- **Multi-bundle symbolication test** — a stack spanning several JS chunks, plus a frame whose bundle has no source map. Handling multiple chunks is why the symbolication code exists, and every fixture before this used a single bundle.

### Changed

**No change to the published API** — `/client`, `/functions`, and `/tools` export exactly what they did in 0.1.0. Everything below is internal.

- **Source map decoding** — a `TraceMap` was rebuilt for every frame of a stack, so a 20-frame trace from one bundle decoded the same mappings 20 times. Maps are now decoded once and reused, on the per-error path inside the Cloud Function.
- **Embedded source map reads** — the current release's maps were read from disk and re-parsed on every error log. They are now cached after first read, and cleared by `clearSourceMapCache()` alongside the Storage cache.
- **Client platform and browser labels** — the user agent was re-parsed with up to nine regexes on every log call. It cannot change during a page's life, so both labels are now resolved once at module load.
- **Breadcrumb trimming** — the whole trail was filtered and reallocated on every breadcrumb, including the usual case where nothing had expired. It is now rebuilt only when the oldest entry has passed the five-minute cutoff.
- **`symbolicateStackTrace`** — took one source map, so it could not serve a stack spanning several bundles, and the log handler carried a private copy of the same frame walk. It now takes a per-frame resolver and the handler calls it instead.

### Removed

- **`getConfiguredBucket`** — replaced by `getBucket`, which returns the configured bucket or the project default directly, rather than a name every caller had to resolve itself. Internal only; it was never reachable from a package entry point.

## [0.1.0] — 2026-08-16

### Added

- **Client logger** — `info` / `warning` / `error` / `debug` with breadcrumbs, session rate limiting, duplicate-error suppression, and global handlers for uncaught errors, unhandled rejections, and React error boundaries.
- **Cloud Functions logger** — request-scoped labels via `AsyncLocalStorage`, so `functionName`, `userId`, and any seeded labels ride every log in a request. Falls back to an anonymous logger outside a request rather than throwing.
- **Client log handler** — `createClientLogHandler` and `createClientLogFunction` build an `onCall` endpoint that validates the incoming payload, symbolicates the stack trace, and writes a structured entry to Cloud Logging.
- **Stack trace symbolication** — minified production traces resolve back to source file, line, and column via `@jridgewell/trace-mapping`. Maps load from the deployed bundle for the current release, or from Firebase Storage for older ones.
- **Log attachments** — files persisted to Cloud Storage alongside an entry and keyed by log ID, so a screenshot or payload dump stays attached to the error it belongs to.
- **Emulator mode** — under `FUNCTIONS_EMULATOR=true`, entries are written to a local `dev.jsonl` with rotation instead of Cloud Logging, so local development needs no live credentials.
- **`fsl` CLI** — source map upload to Storage, deploy packing, and skill installation.

[Unreleased]: https://github.com/dasasian/firebase-structured-logger/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/dasasian/firebase-structured-logger/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/dasasian/firebase-structured-logger/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dasasian/firebase-structured-logger/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/dasasian/firebase-structured-logger/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dasasian/firebase-structured-logger/releases/tag/v0.1.0
