# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/dasasian/firebase-structured-logger/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dasasian/firebase-structured-logger/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/dasasian/firebase-structured-logger/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dasasian/firebase-structured-logger/releases/tag/v0.1.0
