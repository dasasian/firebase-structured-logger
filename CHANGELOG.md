# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/dasasian/firebase-structured-logger/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/dasasian/firebase-structured-logger/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dasasian/firebase-structured-logger/releases/tag/v0.1.0
