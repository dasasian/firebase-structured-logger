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

Your web app crashed at `app-4f2a.js:1:98432`. This tells you it was `Checkout.tsx:42` — in your own Google Cloud project, next to your backend logs. Nothing leaves.

Ships a client logger, a Cloud Functions logger, and the `fsl` CLI.

## One query, both halves

Frontend and backend write to the same stream in the same shape, so one filter reads the whole story in order:

```
labels.userId="<uid>"
```

```
10:42:03.114  INFO   screen=checkout      click "Apply code"
10:42:03.118  INFO   screen=checkout      applying discount SAVE20
10:42:03.402  INFO   fn=applyDiscount     started
10:42:03.611  ERROR  fn=applyDiscount     coupon lookup failed: timeout
10:42:03.798  ERROR  screen=checkout      TypeError at Checkout.tsx:42:9
```

Two of those lines came from a browser and three from a server. You never had to think about that, and you never had to correlate two systems by timestamp to see it.

**Every label in that query and those lines was attached automatically.** You write the message; the rest rides along. See [What you get for free](#what-you-get-for-free).

## How it works

```
   Browser                     Your Cloud Functions            Cloud Logging
   ┌────────────────┐          ┌──────────────────────┐        ┌───────────────┐
   │ no credentials │─────────▶│ logFrontendEvent()   │───────▶│ your project  │
   │ no source maps │          │ credentials + maps   │        │ one stream    │
   └────────────────┘          ├──────────────────────┤        │ one query     │
                               │ your own functions   │───────▶│               │
                               │ withLogging()        │        └───────────────┘
                               └──────────────────────┘
```

**Why there is a function in the middle.** A browser cannot write to Cloud Logging — it has no credentials, and you would never ship credentials to a browser. So the frontend needs a door, and `logFrontendEvent` is it. Because every frontend error passes through that door anyway, it is also the only place that can hold your source maps: the browser must not have them (`fsl` strips them from `dist/` so they are never published), and Cloud Logging cannot apply them. **Symbolication happens there because there is nowhere else it can happen.**

Both boxes in the middle are your own Cloud Functions, in the deploy you already run. Nothing new to stand up.

## Install

```bash
# frontend (project root)
npm install @dasasian/firebase-structured-logger

# Cloud Functions
cd functions && npm install @dasasian/firebase-structured-logger
```

Ships ESM with three entry points — `/client`, `/functions`, `/tools` — plus the `fsl` CLI. `firebase`, `firebase-admin`, and `firebase-functions` are optional peer dependencies (bring your own versions).

## Setup

Most projects do both halves. They share one step — `initLogger` inside `functions/` — and
are otherwise independent.

**Prerequisites**

- A `functions/` directory (`firebase init functions`, TypeScript) referenced by `firebase.json`.
- For browser errors: **Firebase Storage enabled** (source maps are uploaded there) —
  Firebase console → **Storage → Get started** — and a frontend build that emits source maps.
  The `fsl` source-map tooling assumes **Vite**.

### Catching errors from your browser

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

`logFunction` is just `(payload) => Promise<unknown>`. `httpsCallable()` happens to fit it —
anything else that fits will work too.

**2. Add the log function** — in `functions/src/index.ts`:

```ts
import { initLogger, createClientLogFunction } from '@dasasian/firebase-structured-logger/functions'

initLogger({ appId: 'my-app' })

export const logFrontendEvent = createClientLogFunction({
  bucketName: 'my-app.firebasestorage.app', // Storage bucket holding source maps
})
```

**3. Wire the deploy script** — upload source maps and strip them from the hosting bundle as part of deploy. Merge into your root `package.json` scripts, keeping any existing flags like `--project`:

```json
"deploy": "export VITE_RELEASE_ID=$(git rev-parse --short HEAD) && npm run build && npx fsl upload-sourcemaps --functions=./functions --embed-sourcemaps && firebase deploy"
```

`fsl upload-sourcemaps` reads the bucket from `VITE_FIREBASE_STORAGE_BUCKET` (or `FIREBASE_STORAGE_BUCKET`) after loading `.env.local`. It uploads source maps to Cloud Storage, embeds a copy in `functions/sourcemaps/current/` for fast lookup, and deletes them from `dist/` so they are **not** served to browsers.

> **`VITE_RELEASE_ID`** ties a build to its source maps — the client tags every entry with it, and `upload-sourcemaps` stores maps under the matching path. Use the same value in both places (the deploy script above sets it once from the git SHA). Locally it defaults to `'dev'`, and no maps are uploaded — symbolication isn't needed in development.

**4. Verify it works** — prove the round trip before you trust it:

```ts
import { triggerTestLog } from '@dasasian/firebase-structured-logger/client'

triggerTestLog() // wire to a dev-only button; sends one error, one warning, one info
```

Look for `labels.errorType="fsl-verify"` — in Cloud Logging once deployed, or in `dev.jsonl`
if you are running the emulator (see [Local development](#local-development)). Three entries,
and the error's stack should name a source file rather than a minified bundle. If they are
not there, nothing else in this README will work either.

Then log, anywhere in the frontend:

```ts
logger.info('checkout started', { orderId })
logger.error(err, { screen: 'camera' }, context, { photo: blob }) // attachments optional
```

Debug logs are suppressed in production automatically.

### Logging from your Cloud Functions

A complete use of this package on its own — no client, no bundles, no source maps.

**1. Initialize the logger** — in `functions/src/index.ts`, at module load:

```ts
import { initLogger } from '@dasasian/firebase-structured-logger/functions'

initLogger({ appId: 'my-app' })
```

Already done if you set up the browser half — it is the same call.

**2. Wrap your handlers** — `withLogging` binds the request's labels for the life of the handler:

```ts
import { withLogging, logInfo, logError } from '@dasasian/firebase-structured-logger/functions'

export const checkout = onCall(
  withLogging({ functionName: 'checkout' }, async (request) => {
    logInfo('started')          // carries functionName and the caller's userId already
    ...
    logError(err, { orderId })  // labels merge with the request's
  }),
)
```

`userId` comes from the verified `request.auth.uid`, so you never pass it. The scope unwinds
when the handler settles — one request's labels can never appear on another's logs, even on a
warm instance.

**3. Verify it works** — call the function, then look for `labels.functionName="checkout"`.
The entry should carry `userId` without your having written it.

## Local development

The Functions emulator writes the same entries to a local JSONL file instead of Cloud
Logging, so the whole loop — client, log function, symbolication path, labels — works
before you deploy anything.

Add a `serve` script to `functions/package.json`:

```json
"serve": "npm run build && firebase emulators:start --only functions"
```

Then tell the logger where to write, in your functions entry point:

```ts
initLogger({ appId: 'my-app', logLocalDir: 'logs' })
```

`logLocalDir` is yours to choose — it is resolved against the emulator's working directory,
which is `functions/`. `functions/logs` is the convention used throughout this README, not a
requirement; anywhere writable works, including a path outside the project.

Point **[firebase-mcp-server](https://github.com/dasasian/firebase-mcp-server)** at that file
to query your dev logs from Claude exactly as you would query Cloud Logging.

### Keep the logs out of git

```
functions/logs/*.jsonl
```

Track the directory, not the files:

```bash
mkdir -p functions/logs && touch functions/logs/.gitkeep
```

### Rotation

Entries go to `{logLocalDir}/dev.jsonl`. Each emulator start rotates the current file to
`dev-{timestamp}.jsonl`, and rotation also happens when the record limit is hit mid-session.

| Config | Default | Description |
|---|---|---|
| `logLocalDir` | — | Directory for local log files |
| `logMaxRecordsPerFile` | 2000 | Records per file before rotation |
| `logMaxRotatedFiles` | 5 | Rotated files to keep |

## What you get for free

You write one label. Eleven fields land.

```ts
logger.error(err, { orderId })
```

| Field | Added by | Where it comes from |
|---|---|---|
| `appId`, `releaseId` | client | your `initLogger` config |
| `screen` | client | tracked as the user moves |
| `userId` | client | `setUser`, held for the session |
| `platform` | client | user agent — `ios` / `android` / `macos` / `web` |
| `browser` | client | user agent |
| `errorType` | client | the Error's own `name` |
| last 50 breadcrumbs | client | the trail of what the user did |
| `logId` | function | a ULID, unique per entry — locates attachments in GCS |
| `hasAttachments` | function | `"true"` when files were uploaded alongside |
| resolved file and line | function | your source maps — `Checkout.tsx:42`, not `app-4f2a.js:1:98432` |
| trace context | function | request correlation in Cloud Logging |

Backend logs get the same treatment: `withLogging` attaches `functionName`, `userId` from
the verified `request.auth.uid`, and whatever else you bind.

That is the "structured" in the name. Not that the entry is JSON — that it arrives already
carrying who, where, which release, and what led up to it.

**The rule behind it:**

> You never pass context to a log call. You declare it once, and it rides along.

On the client that scope is the **session**. On the backend it is the **request**. Same idea,
two clocks — and it is why `labels.userId="…"` returns both halves: the client attaches the
uid from `setUser`, the backend from `request.auth.uid`, same label name, no coordination.

Declaring context does not replace passing it. There are three scopes, and they merge:

```ts
initLogger({ appId: 'my-app' })       // every log, for the life of the app
logger.setUser(uid, { orgId })        // every log, until clearUser()
logger.error(err, { orderId })        // this log only
```

Innermost wins — a label passed at the call site overrides the same label from `setUser`.
The backend works the same way: `withLogging` binds the request's labels, and each
`logInfo(message, labels)` can add or override for that one line.

## Adding your own context

Define your labels once, in a file both the app and `functions/` import:

```ts
// src/shared/labels.ts
export interface MyAppLabels {
  organizationId?: string
  itemId?: string
  // whatever domain entities are relevant
}
```

Then use the same type on both sides.

**Client** — scoped to the session:

```ts
export const logger = initLogger<MyAppLabels>({ /* … */ })

logger.setUser(uid, { organizationId })   // on sign in — rides every log until cleared
logger.clearUser()                        // on sign out
logger.setScreen('checkout')              // on navigation
```

**Backend** — scoped to the request:

```ts
import { withLogging, logInfo } from '@dasasian/firebase-structured-logger/functions'

export const checkout = onCall(
  withLogging<MyAppLabels>(
    (request) => ({ functionName: 'checkout', labels: { organizationId: request.data.orgId } }),
    async (request) => {
      logInfo('started')   // carries functionName, userId and organizationId already
    },
  ),
)
```

The function form runs per call, so labels can be derived from the request. The static form
from [setup](#logging-from-your-cloud-functions) is the same thing without that.

## Breadcrumbs

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

## User feedback

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
`platform`, `browser`, and any labels seeded via `setUser`. A screenshot passed as an
attachment rides the same Cloud Storage path as any other, so it is not bounded by the
entry size limit — see [Attachments](#attachments).

Headless: the package renders nothing, so the UI is yours. It returns nothing either —
a reference number is meaningless to a user with no portal to check it against. Say thank
you and move on; if the app wants correlation, pass its own id as a label.

Entries are written at **`NOTICE`**, which ranks between `INFO` and `WARNING`: feedback
from a person outranks routine status, and is not a warning about system health. Find it
with the severity dropdown, or `labels.feedback="true"`. Any existing `severity >= WARNING`
alert ignores it with no configuration.

Feedback is exempt from the severity floor and the rate limiter — those are volume controls
for events the system emits, and someone hitting send twice is not a duplicate to throttle.

## Attachments

```ts
logger.error(err, { orderId }, context, { photo: blob, state: JSON.stringify(cart) })
```

Any log method takes a final `attachments` argument — `Record<string, Blob | File | string>`
on the client, `Record<string, string | Buffer>` on the backend.

**Attachments are how you send more than a log entry can hold.** A Cloud Logging entry is
capped at **256 KB**, and a big payload does not get truncated — the write fails. Attachments
never enter the entry: they are uploaded to Cloud Storage and stripped before the entry is
written, so a 5 MB screenshot costs the log line two labels. Use them for anything that would
otherwise blow the cap — screenshots, request bodies, a serialised store, a captured frame.

They land at:

```
gs://<bucket>/logAttachments/{logId}/{name}
```

`logId` is a ULID on the entry itself, so the log line tells you where its files are:

```
labels.hasAttachments="true"     # entries that have files
labels.logId="01J..."            # the entry whose files you are looking for
```

By default they share the bucket passed to `createClientLogFunction({ bucketName })` — the
same one the source maps live in, falling back to the project's default bucket.

Send them somewhere else with `configureAttachments`, in your functions entry point:

```ts
import { configureAttachments } from '@dasasian/firebase-structured-logger/functions'

configureAttachments({ bucket: 'my-app-user-content', prefix: 'evidence' })
```

Call it once, at module load. It is global on purpose and global in the API: the upload
happens on every log call, including ones inside your own handlers that never touch
`createClientLogFunction`, so there is no per-handler setting for it to read. Fields you
leave out keep today's behaviour, and never calling it changes nothing.

Worth doing when user content needs its own region for residency, its own retention policy,
or different IAM from your source maps — none of which can be arranged with a prefix.

Nothing expires them. Add a lifecycle rule on `logAttachments/` to delete after N days, or
they accumulate for the life of the project.

## Volume controls

Three separate gates decide whether a log is written. All have defaults, and the defaults
drop things — so this is worth reading before you conclude something is broken.

| Gate | Default | Where |
|---|---|---|
| Session limit | **50 logs**, then the client stops sending | client, per browser session |
| Duplicate limit | **3 copies** of the same error, then it stops | client, per browser session |
| Client severity floor | `WARNING` in production, `DEBUG` in dev | client, `minLogLevel` |
| Server severity floor | `WARNING` in production, `DEBUG` in the emulator | function, `minSeverity` |
| Function concurrency | `maxInstances: 1` on `createClientLogFunction` | function |

```ts
initLogger({
  appId: 'my-app',
  releaseId,
  logFunction,
  minLogLevel: 'INFO',
  rateLimitOptions: { sessionLimit: 200, duplicateLimit: 5 },
})
```

Two errors count as duplicates when the **message and the screen both match**, so the same
error on two different screens is not collapsed into one. The budget lives in
`sessionStorage` and resets with the session.

### What a dropped log looks like

The two rate limits say so in the browser console:

```
[fsl] Duplicate suppressed: TypeError: cannot read 'id'|checkout
[fsl] Session log limit reached
```

**The severity floors are silent.** Both of them — the client's `minLogLevel` and the
function's `minSeverity` — simply return, with nothing written and nothing logged about it.

So if an entry never arrived and there is no `[fsl]` warning in the console, it was a floor,
not a limit. In production both default to `WARNING`, which drops `DEBUG`, `INFO` and
`NOTICE` on the way out of the browser *and* again on the way into Cloud Logging — an
`INFO` you expected to see has two places it can vanish.

`maxInstances: 1` is a deliberate cost guard on what is usually the busiest function in the
system. Raise it (`createClientLogFunction({ bucketName, maxInstances: 5 })`) if you are
dropping client logs under load — and watch your Cloud Logging bill when you do.

Feedback is exempt from every one of these. See [User feedback](#user-feedback).

## Querying

One filter, both halves, in time order:

```
labels.userId="<uid>"
```

Narrow it when you need to:

| Filter | Returns |
|---|---|
| `labels.platform:*` | client entries only |
| `labels.functionName:*` | server entries only |
| `labels.releaseId="<sha>"` | one build |
| `labels.screen="checkout"` | one screen |
| `labels.feedback="true"` | user-reported issues |
| `labels.hasAttachments="true"` | entries with files in GCS |

Locally, the emulator's JSONL answers the same questions. Point
**[firebase-mcp-server](https://github.com/dasasian/firebase-mcp-server)** at either and ask
Claude instead — `npx fsl install-skills` installs the two skills below.

| Skill | Description |
|-------|-------------|
| `/logs` | Validate logging in a file — error paths, labels, PII, unwrapped handlers, breadcrumbs |
| `/query-logs` | Query Cloud Logging or local JSONL via [firebase-mcp-server](https://github.com/dasasian/firebase-mcp-server) |

> A stack trace is self-reported by the browser, and so is `userId` on client entries — the
> uid comes from the client's own labels, not from a verified token. Backend entries are
> different: `withLogging` reads `request.auth.uid`, which Firebase has verified. Fine for
> debugging either way; don't build an audit trail on the client half.

## Reference

### Client

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

Also exported: `initLogger`, `getClientLogger`, `setupGlobalErrorHandler`, `handleReactError`,
`sendFeedback`, `triggerTestLog`, `addBreadcrumb`, `bc`.

`Logger` is exported as a **type only** — the client logger is a session singleton, so
annotate with `Logger<MyAppLabels>` and construct with `initLogger()`. A second instance
would silently share breadcrumbs, screen and the rate-limit budget while looking independent.


### Functions

```ts
initLogger({ appId, logLocalDir?, minSeverity?, logMaxRecordsPerFile?, logMaxRotatedFiles? })

withLogging(options | (request) => options, handler)
getLogger()                       // the current request's writer, or an anonymous fallback
logError / logWarn / logInfo / logDebug (message, labels?, context?, attachments?)

createClientLogFunction({ bucketName, cors?, maxInstances? })   // ready to export
createClientLogHandler({ bucketName })                          // the bare handler, wrap it yourself
```

Backend log methods also accept an optional `attachments` (`Record<string, string | Buffer>`).

### CLI (`fsl`)

```bash
# Upload source maps to Cloud Storage and strip local .map files (run in deploy)
npx fsl upload-sourcemaps --functions=./functions --embed-sourcemaps

# Install the Claude Code skills into the current project (or --global, --force)
npx fsl install-skills
```

### Source maps

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

To use a different bucket or prefix, tell **both ends** — they are two halves of one contract
and nothing checks them against each other:

```bash
npx fsl upload-sourcemaps --bucket=my-maps --prefix=fsl-maps …
```

```ts
createClientLogFunction({ sourceMaps: { bucket: 'my-maps', prefix: 'fsl-maps' } })
```

If they disagree the maps are simply not found and stacks stay minified — which looks
identical to never having uploaded them. The function warns once per release when it
resolves nothing, naming the exact object it looked for, so the mismatch is visible in your
logs rather than inferred.

## What this is not

An error tracker. There is no issue state here — nothing to resolve, ignore, assign, or mark as regressed, and no notion of "this is the same bug as that one." Errors arrive as structured, queryable log entries, not as a triage queue.

If you want a list of your top twelve problems ranked by frequency with a resolve button, Sentry sells that and sells it well. What this gives you instead is every frontend and backend event in one stream you already own, in one query language, with nothing handed to a third party.

## License

MIT © Dasasian
