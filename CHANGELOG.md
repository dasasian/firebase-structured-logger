# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`withLogging(options, handler)`** — the correct way to scope a request logger. Wraps an `onCall` handler, binds the request's labels with `AsyncLocalStorage.run()`, and unwinds when the handler settles. Options may be an object or a function of the request, for labels derived from the payload.

### Deprecated

- **`initRequestLogger` — removed in 0.6.0.** It binds with `enterWith()`, which is never unwound, so a request's labels outlive the request. A later handler that does *not* call it — a scheduled function, a Firestore or Storage trigger, or anything relying on `getLogger()`'s anonymous fallback — inherits whichever user last touched the warm instance. Reproduced: a handler that never called it logged `userId: alice` from the previous request. Handlers that all call it are unaffected; the hazard is the ones that don't. It still works, and now warns once per function name explaining the leak.

### Fixed

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

[Unreleased]: https://github.com/dasasian/firebase-structured-logger/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/dasasian/firebase-structured-logger/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dasasian/firebase-structured-logger/releases/tag/v0.1.0
