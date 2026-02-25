# firebase-structured-logger

Structured logging for Firebase apps — client, functions, and tools.

Sends frontend logs to a Cloud Function, symbolicates stack traces, and writes structured entries to Google Cloud Logging — queryable via [firebase-mcp-server](https://github.com/your-org/firebase-mcp-server).

---

## Add to your project

Copy this prompt into Claude Code:

```
Set up firebase-structured-logger in this project.
Ask me for the path to the firebase-structured-logger directory before proceeding.
```

---

## Manual setup

### Prerequisites

Before starting, confirm:

- [ ] A `functions/` directory exists with `package.json`, `tsconfig.json`, and `src/index.ts`
- [ ] `firebase.json` has a `"functions"` entry pointing to that directory
- [ ] Your frontend build tool is Vite (the deploy script and source map tooling assume Vite)
- [ ] Firebase Storage is enabled in your project (required for source map uploads) — enable it in the Firebase console under **Storage → Get started**

**If you don't have Cloud Functions yet**, initialise them first:
```bash
firebase init functions
```
Then choose TypeScript and accept the defaults. This creates `functions/`, `firebase.json` entries, and `functions/tsconfig.json`.

---

### 1. Add dependencies

**Root `package.json`** (frontend):
```json
"firebase-structured-logger": "file:../firebase-structured-logger"
```

**`functions/package.json`** (Cloud Functions):
```json
"firebase-structured-logger": "file:../../firebase-structured-logger"
```

Run `npm install` in both.

---

### 2. Add to `.gitignore`

```
functions/vendor/
functions/logs/*.jsonl
```

The `vendor/` directory holds the deploy-time tgz — it should not be committed. The `logs/` directory holds local JSONL log files from the emulator — the directory should be tracked but not the log files.

Create the log directory so git tracks it:
```bash
mkdir -p functions/logs && touch functions/logs/.gitkeep
```

---

### 3. Wire deploy scripts

Merge the following into your existing deploy scripts in the root `package.json` — don't replace them wholesale, keep any existing flags like `--project`:

```json
"deploy": "export VITE_RELEASE_ID=$(git rev-parse --short HEAD) && npm run build && npx fsl upload-sourcemaps --functions=./functions --embed-sourcemaps && npx fsl pack --functions=./functions && firebase deploy",
"postdeploy": "npx fsl pack-restore --functions=./functions"
```

`fsl upload-sourcemaps` reads the bucket name from `VITE_FIREBASE_STORAGE_BUCKET` (or `FIREBASE_STORAGE_BUCKET`) after loading `.env.local`. It uploads source maps to Cloud Storage, embeds a copy in `functions/sourcemaps/current/` for fast lookup, and deletes them from `dist/` so they are not deployed to hosting.

`fsl pack` builds and packs the package into `functions/vendor/`, patches `functions/package.json`
to reference it, and runs `npm install`. `fsl pack-restore` undoes this after deploy.

---

### 4. Initialise the client logger

The best place for this is your app's entry point — typically `src/main.tsx`, `src/main.ts`, or wherever you initialise Firebase. It must run before any logging calls.

```ts
import { initLogger, setupGlobalErrorHandler } from 'firebase-structured-logger/client'
import { httpsCallable } from 'firebase/functions'
import { functions } from './config/firebase'

export const logger = initLogger({
  appId: 'my-app',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
  logFunction: httpsCallable(functions, 'logFrontendEvent'),
})

setupGlobalErrorHandler()
```

**`VITE_RELEASE_ID`** — required for symbolicated stack traces in production. Used by both the client (to tag log entries) and `fsl upload-sourcemaps` (to store maps under the matching path). Must be the same value in both places.

The simplest approach — set it once in your deploy script and let both tools read it automatically:
```json
"deploy": "VITE_RELEASE_ID=$(git rev-parse --short HEAD) npm run build && npx fsl upload-sourcemaps ..."
```
`fsl upload-sourcemaps` reads `VITE_RELEASE_ID` from the environment automatically (no `--release` flag needed).

Locally, the client defaults to `'dev'` which is fine — source maps aren't uploaded during development so symbolication isn't needed.

---

### 5. Define app-specific labels

```ts
interface MyAppLabels {
  organizationId?: string
  itemId?: string
  // add whatever domain entities are relevant
}

export const logger = initLogger<MyAppLabels>({ ... })
```

---

### 6. Wire user context

```ts
// On sign in:
logger.setUser(uid, { /* app-specific labels */ })

// On sign out:
logger.clearUser()

// On navigation:
logger.setScreen('screenName')
```

---

### 7. Add the Cloud Function

In `functions/src/index.ts`:
```ts
import { initLogger, createClientLogFunction } from 'firebase-structured-logger/functions'

initLogger({
  appId: 'my-app',
  logLocalDir: process.env.DEV_LOG_DIR ?? './logs',  // emulator only
})

export const logFrontendEvent = createClientLogFunction({
  bucketName: 'my-firebase-app.firebasestorage.app',
})
```

---

## Client API

```ts
logger.error(error: unknown, labels?, context?)
logger.info(message: string, labels?, context?)
logger.warning(message: string, labels?, context?)
logger.debug(message: string, labels?, context?)

logger.setUser(uid, extraLabels?)
logger.clearUser()
logger.setScreen(screen)
logger.addBreadcrumb(type, name, data?)
```

Debug logs are suppressed in production automatically.

---

## Functions API

```ts
import { initLogger, initRequestLogger, logError, logInfo } from 'firebase-structured-logger/functions'

// At module load:
initLogger({ appId: 'my-app' })

// At function entry — auto-seeds userId and functionName:
export const myFunction = onCall(async (request) => {
  initRequestLogger(request, { functionName: 'myFunction' })
  logInfo('started')
})
```

---

## CLI reference

```bash
# Build + pack for deployment (run before firebase deploy)
npx fsl pack --functions=./functions

# Restore package.json after deploy
npx fsl pack-restore --functions=./functions

# Upload source maps to Cloud Storage and delete local .map files
# Reads bucket from VITE_FIREBASE_STORAGE_BUCKET env var (.env.local loaded automatically)
# Release ID: --release > RELEASE_ID > VITE_RELEASE_ID (from .env.local) — required, no fallback
# Authenticates via FIREBASE_SERVICE_ACCOUNT_PATH if set, otherwise uses ADC
npx fsl upload-sourcemaps [--bucket=<name>] [--functions=<path>] [--embed-sourcemaps] [--release=<id>]

# Install skills into current project
npx fsl install-skills

# Install skills globally
npx fsl install-skills --global

# Overwrite existing skills without prompting
npx fsl install-skills --force
```

---

## Skills

Install skills to enable Claude Code log validation and querying:

```bash
npx fsl install-skills
```

| Skill | Description |
|-------|-------------|
| `/logs` | Validate logging in a file — checks error paths, labels, PII, missing `initRequestLogger`, breadcrumbs |
| `/query-logs` | Query Cloud Logging or local JSONL via firebase-mcp-server |

**Example — `/logs src/services/inventoryService.ts`:**
```
VIOLATIONS FOUND: 2

1. Line 42 - Missing logError in catch block
2. Line 67 - console.error used directly instead of logError

MISSING LOGGING: 1

1. Line 89 - Error path returns null with no log

LABEL COMPLETENESS:
✗ placeId missing — placeId is in scope at line 42
✓ organizationId included
```

---

## Verifying the pipeline

### 1. Set up the log directory

Set `DEV_LOG_DIR` in your environment (e.g. `.env.local`):
```
DEV_LOG_DIR=./functions/logs
```

Set the same value in your firebase-mcp-server config so Claude can query local logs.

### 2. Start the emulator

```bash
firebase emulators:start --only functions
```

### 3. Add a test button (dev only)

```tsx
import { triggerTestLog } from 'firebase-structured-logger/client'

// Render only in dev
{import.meta.env.DEV && (
  <button onClick={triggerTestLog}>Test Logging</button>
)}
```

### 4. Clear Vite's dependency cache

> **Important:** Do this after first installing FSL, and again any time you rebuild FSL locally.
> Vite pre-bundles dependencies at startup and will serve stale code otherwise.

```bash
npm run dev -- --force
```

### 5. Click the button and verify

**Check the log file:**
```bash
tail -f functions/logs/dev.jsonl
```
You should see three entries with `"errorType":"fsl-verify"` — one ERROR, one WARNING, one INFO.

**Check symbolication:**
The ERROR entry's `jsonPayload.error.stack` should resolve to a source file and line number, not a minified bundle.

**Query via MCP:**
```
source: local
where: [{ field: "labels.errorType", operator: "==", value: "fsl-verify" }]
```

---

## Local log rotation

Logs are written to `{logLocalDir}/dev.jsonl`. On each emulator start, the current file is rotated to `dev-{timestamp}.jsonl`. When the record limit is hit mid-session, rotation happens automatically.

| Config | Default | Description |
|---|---|---|
| `logLocalDir` | — | Directory for local log files |
| `logMaxRecordsPerFile` | 2000 | Records per file before rotation |
| `logMaxRotatedFiles` | 5 | Number of rotated files to keep |

---

## Source maps

To get symbolicated stack traces in production:

1. Add to your Vite build:
```ts
// vite.config.ts
build: {
  sourcemap: true,
  commonjsOptions: {
    // Required: Rollup's commonjs plugin doesn't cover file: deps by default
    include: [/firebase-structured-logger/, /node_modules/],
  },
}
```

2. After building, upload and delete local maps:
```bash
npx fsl upload-sourcemaps --bucket=my-bucket
```

Source maps are stored at `gs://my-bucket/sourcemaps/{releaseId}/{filename}.map` and loaded by the Cloud Function during symbolication.
