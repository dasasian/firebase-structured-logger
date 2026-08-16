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

## Functions API

```ts
import { initLogger, initRequestLogger, logError, logInfo } from '@dasasian/firebase-structured-logger/functions'

initLogger({ appId: 'my-app' }) // at module load

export const myFunction = onCall(async (request) => {
  initRequestLogger(request, { functionName: 'myFunction' }) // seeds userId + functionName
  logInfo('started')
})
```

Backend log methods also accept an optional `attachments` (`Record<string, string | Buffer>`).

## CLI (`fsl`)

```bash
# Upload source maps to Cloud Storage and strip local .map files (run in deploy)
npx fsl upload-sourcemaps [--bucket=<name>] [--functions=<path>] [--embed-sourcemaps] [--release=<id>]

# Install the Claude Code skills into the current project (or --global, --force)
npx fsl install-skills
```

> The `fsl pack` / `pack-restore` commands exist only for consuming this package via a local `file:` dependency (they vendor a tgz so `firebase deploy` can bundle it). When you install from npm — as above — you don't need them.

## Skills

```bash
npx fsl install-skills
```

| Skill | Description |
|-------|-------------|
| `/logs` | Validate logging in a file — error paths, labels, PII, missing `initRequestLogger`, breadcrumbs |
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
