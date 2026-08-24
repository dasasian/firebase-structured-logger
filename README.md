<p align="center">
  <img src="https://raw.githubusercontent.com/dasasian/firebase-structured-logger/main/assets/hero.svg" alt="firebase-structured-logger — structured logging for Firebase apps" width="900">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dasasian/firebase-structured-logger"><img alt="npm" src="https://img.shields.io/npm/v/@dasasian/firebase-structured-logger?style=flat-square&label=npm&color=235a9b"></a>
  <a href="https://github.com/dasasian/firebase-structured-logger/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/dasasian/firebase-structured-logger/ci.yml?branch=main&style=flat-square&label=CI"></a>
</p>

<p align="center">
  <a href="https://dasasian.com/firebase-structured-logger"><strong>dasasian.com/firebase-structured-logger</strong></a>
</p>

# @dasasian/firebase-structured-logger

One logging pipeline for a Firebase app, from the browser to Google Cloud Logging: frontend events go to a Cloud Function, production stack traces are **symbolicated** against your source maps, and everything is written as **structured, queryable entries**. Ships a client logger, a Cloud Functions logger, and an `fsl` CLI.

## Why

- **Symbolicated frontend errors** — minified production traces resolve back to `File.tsx:line:col` using source maps you upload at deploy time. No more chasing `app-4f2a.js:1:98432`.
- **Structured entries** — severity, labels, user / session / screen context, breadcrumbs, and file attachments, all queryable in Cloud Logging.
- **One API across surfaces** — the same `logger.info/warning/error/debug` shape on the client and in Cloud Functions.
- **Local dev loop** — the Functions emulator writes JSONL you can `tail` or query without deploying — and query from Claude with the companion [**firebase-mcp-server**](https://github.com/dasasian/firebase-mcp-server).

## Install

```bash
# frontend (project root)
npm install @dasasian/firebase-structured-logger

# Cloud Functions
cd functions && npm install @dasasian/firebase-structured-logger
```

Ships ESM with three entry points — `/client`, `/functions`, `/tools` — plus the `fsl` CLI. `firebase`, `firebase-admin`, and `firebase-functions` are optional peer dependencies (bring your own versions).

## Quick start

**1. Initialize the client** — at your app entry (e.g. `src/main.tsx`), before any logging:

```ts
import { initLogger, setupGlobalErrorHandler } from '@dasasian/firebase-structured-logger/client'
import { httpsCallable } from 'firebase/functions'
import { functions } from './config/firebase'

export const logger = initLogger({
  appId: 'my-app',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
  logFunction: httpsCallable(functions, 'logFrontendEvent'),
})

setupGlobalErrorHandler() // capture uncaught errors + unhandled rejections
```

**2. Add the Cloud Function** — in `functions/src/index.ts`:

```ts
import { initLogger, createClientLogFunction } from '@dasasian/firebase-structured-logger/functions'

initLogger({ appId: 'my-app' })

export const logFrontendEvent = createClientLogFunction({
  bucketName: 'my-app.firebasestorage.app', // Storage bucket holding source maps
})
```

**3. Log** — anywhere in the frontend:

```ts
logger.info('checkout started', { orderId })
logger.error(err, { screen: 'camera' }, context, { photo: blob }) // attachments optional
```

Debug logs are suppressed in production automatically. That's the happy path — the rest of this doc covers source-map symbolication, user context, the CLI, and the local emulator loop.

---

## How it works

```
Browser  ──logFrontendEvent()──▶  Cloud Function  ──symbolicate──▶  Cloud Logging
 (client)      httpsCallable          (functions)     (source maps)   (structured)
```

- The **client** batches structured events and calls your `logFrontendEvent` Cloud Function.
- The **function** symbolicates any stack trace against source maps in Cloud Storage, then writes a structured entry (in production) or a local JSONL file (in the emulator).
- You query the result in **Cloud Logging**, or locally from Claude via **[firebase-mcp-server](https://github.com/dasasian/firebase-mcp-server)** (`@dasasian/firebase-mcp-server`).

## Full setup

### Prerequisites

- A `functions/` directory (`firebase init functions`, TypeScript) referenced by `firebase.json`.
- **Firebase Storage enabled** (source maps are uploaded there): Firebase console → **Storage → Get started**.
- A frontend build that emits source maps. The `fsl` source-map tooling assumes **Vite**.

### 1. `.gitignore`

```
functions/logs/*.jsonl
```

The `logs/` directory holds local JSONL from the emulator — track the directory, not the files:

```bash
mkdir -p functions/logs && touch functions/logs/.gitkeep
```

### 2. Wire the deploy script

Upload source maps (and strip them from the hosting bundle) as part of deploy. Merge into your root `package.json` scripts — keep any existing flags like `--project`:

```json
"deploy": "export VITE_RELEASE_ID=$(git rev-parse --short HEAD) && npm run build && npx fsl upload-sourcemaps --functions=./functions --embed-sourcemaps && firebase deploy"
```

`fsl upload-sourcemaps` reads the bucket from `VITE_FIREBASE_STORAGE_BUCKET` (or `FIREBASE_STORAGE_BUCKET`) after loading `.env.local`. It uploads source maps to Cloud Storage, embeds a copy in `functions/sourcemaps/current/` for fast lookup, and deletes them from `dist/` so they are **not** served to browsers.

> **`VITE_RELEASE_ID`** ties a build to its source maps — the client tags every entry with it, and `upload-sourcemaps` stores maps under the matching path. Use the same value in both places (the deploy script above sets it once from the git SHA). Locally it defaults to `'dev'`, and no maps are uploaded — symbolication isn't needed in development.

### 3. Typed labels + user context

```ts
interface MyAppLabels {
  organizationId?: string
  itemId?: string
  // whatever domain entities are relevant
}

export const logger = initLogger<MyAppLabels>({ /* … */ })

logger.setUser(uid, { /* app labels */ }) // on sign in
logger.clearUser()                        // on sign out
logger.setScreen('checkout')              // on navigation
```

### 4. Run the emulator (local capture)

Add a `serve` script to `functions/package.json`:

```json
"serve": "npm run build && firebase emulators:start --only functions"
```

The emulator writes entries to `DEV_LOG_DIR` (e.g. `functions/logs/dev.jsonl`), so you can inspect logs without deploying — and point **[firebase-mcp-server](https://github.com/dasasian/firebase-mcp-server)** at that same file to query your dev logs from Claude.

## Client API

```ts
logger.error(error, labels?, context?, attachments?)   // attachments: Record<string, Blob | File | string>
logger.info(message, labels?, context?, attachments?)
logger.warning(message, labels?, context?, attachments?)
logger.debug(message, labels?, context?, attachments?) // suppressed in production

logger.setUser(uid, extraLabels?)
logger.clearUser()
logger.setScreen(screen)
logger.addBreadcrumb(type, name, data?)
```

**Attachments** (images, snapshots, captured data) upload to GCS at `logAttachments/{logId}/{name}`; the same `logId` is on the entry's `labels.logId`. Add a lifecycle rule to auto-delete `logAttachments/` after N days.

### Breadcrumbs

```ts
import { bc } from '@dasasian/firebase-structured-logger/client'

bc.nav('Checkout')                              // also sets labels.screen
bc.action('apply_discount', { code: 'SAVE10' })
bc.state('total_recalculated', { total: 42.00 })
bc.error('ValidationError', { field: 'price' })
```

A stack trace tells you where the code broke. It cannot tell you what the person did to
get there, which is usually the part you need to reproduce it. Breadcrumbs are that trail:
a rolling record of the last steps, attached automatically to every error and every piece
of feedback, with no correlation work on your side.

Drop a `bc.action` before anything that can fail and a `bc.nav` on every screen change, and
`total is wrong` arrives as `navigate_Checkout · apply_discount · total_recalculated ·
tap_place_order`.

The trail is capped at **50 entries** and **5 minutes** — old enough to cover the steps that
led here, short enough that it stays the current attempt rather than the whole session, and
bounded so a long-lived tab cannot grow it without limit. It lives in memory only, so it
never touches storage and never leaves the device except attached to a log you send.

Breadcrumbs are session-global by design: one user, one path. `bc.nav()` also sets the
current screen, so `labels.screen` stays correct without a second call.

> Record the step, not the data. Breadcrumb `data` is written to your logs verbatim — keep
> PII, tokens and card numbers out of it, the same as you would for any label.

### User feedback

```ts
import { sendFeedback } from '@dasasian/firebase-structured-logger/client'

sendFeedback("the discount didn't apply")
sendFeedback(text, { attachments: { screenshot }, labels: { orderId } })
```

Error tracking only sees things that **throw**. A button that does nothing, a total that
comes out wrong, the wrong data rendered — none of them throw, so none are captured, and
you hear about them weeks later. `sendFeedback` captures that class, and it is actionable
because the breadcrumb trail is already in memory when the user hits send: *"the discount
didn't apply"* is a complaint; the same sentence plus `nav→Checkout · apply_discount ·
total_recalculated · tap_place_order` is a reproduction.

It carries everything a log carries — breadcrumbs, `screen`, `userId`, `releaseId`,
`platform`, `browser`, and any labels seeded via `setUser`.

Headless: the package renders nothing, so the UI is yours. It returns nothing either —
a reference number is meaningless to a user with no portal to check it against. Say thank
you and move on; if the app wants correlation, pass its own id as a label.

Entries are written at **`NOTICE`**, which ranks between `INFO` and `WARNING`: feedback
from a person outranks routine status, and is not a warning about system health. Find it
with the severity dropdown, or `labels.feedback="true"`. Any existing `severity >= WARNING`
alert ignores it with no configuration.

Feedback is exempt from the severity floor and the rate limiter — those are volume controls
for events the system emits, and someone hitting send twice is not a duplicate to throttle.

## Functions API

```ts
import { initLogger, withLogging, logError, logInfo } from '@dasasian/firebase-structured-logger/functions'

initLogger({ appId: 'my-app' }) // at module load

export const myFunction = onCall(
  withLogging({ functionName: 'myFunction' }, async (request) => {
    logInfo('started') // carries userId + functionName automatically
  }),
)
```

`withLogging` binds the request's labels for the duration of the handler and unwinds
afterwards, so one request's `userId` can never appear on another's logs. Labels that
depend on the request are computed per call:

```ts
withLogging(
  (request) => ({ functionName: 'myFunction', labels: { orgId: request.data.orgId } }),
  async (request) => { /* … */ },
)
```

> **Migrating from `initRequestLogger`?** It was removed in 0.6.0 — wrap the handler in
> `withLogging` instead of calling it as the first line. It bound the scope with
> `enterWith()`, which is never unwound, so the labels outlived the request and a later
> handler that did *not* call it (a scheduled function, a Firestore trigger, or anything
> relying on `getLogger()`'s anonymous fallback) inherited whichever user last touched the
> warm instance. Codebases where every handler called it were unaffected; the hazard was
> the ones that didn't. `withLogging` uses `run()`, which restores the previous scope when
> the handler settles.

Backend log methods also accept an optional `attachments` (`Record<string, string | Buffer>`).

## CLI (`fsl`)

```bash
# Upload source maps to Cloud Storage and strip local .map files (run in deploy)
npx fsl upload-sourcemaps [--bucket=<name>] [--functions=<path>] [--embed-sourcemaps] [--release=<id>]

# Install the Claude Code skills into the current project (or --global, --force)
npx fsl install-skills
```

> To try an unreleased change in a real deployment, publish a prerelease and install it:
> `npm publish --tag beta`, then `npm i @dasasian/firebase-structured-logger@beta`. For local work against a checkout, `npm link` avoids publishing entirely.

## Skills

```bash
npx fsl install-skills
```

| Skill | Description |
|-------|-------------|
| `/logs` | Validate logging in a file — error paths, labels, PII, unwrapped handlers, breadcrumbs |
| `/query-logs` | Query Cloud Logging or local JSONL via [firebase-mcp-server](https://github.com/dasasian/firebase-mcp-server) |

## Local log rotation

Logs write to `{logLocalDir}/dev.jsonl`; each emulator start rotates the current file to `dev-{timestamp}.jsonl`, and rotation also happens when the record limit is hit mid-session.

| Config | Default | Description |
|---|---|---|
| `logLocalDir` | — | Directory for local log files |
| `logMaxRecordsPerFile` | 2000 | Records per file before rotation |
| `logMaxRotatedFiles` | 5 | Rotated files to keep |

## Source maps

For symbolicated production traces, emit source maps in Vite and upload them at deploy:

```ts
// vite.config.ts
build: {
  sourcemap: true,
  commonjsOptions: {
    // Rollup's commonjs plugin doesn't cover file: deps by default
    include: [/firebase-structured-logger/, /node_modules/],
  },
}
```

Maps are stored at `gs://<bucket>/sourcemaps/{releaseId}/{filename}.map` and loaded by the Cloud Function during symbolication.

## License

MIT © Dasasian
