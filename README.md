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

Ships a browser logger, a server logger, and the `fsl` CLI. Built for Firebase, but
Firebase is optional: the browser half has no Firebase dependency, and the server half
runs on Cloud Functions, Cloud Run, or any Node server on Google Cloud, where stdout goes
to Cloud Logging. What it needs is a Google Cloud project — that is where the logs live.

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

# Cloud Run, or any Node server on Google Cloud
npm install @dasasian/firebase-structured-logger
```

Ships ESM with three entry points — `/client`, `/functions`, `/tools` — plus the `fsl` CLI. `firebase`, `firebase-admin`, and `firebase-functions` are optional peer dependencies (bring your own versions). None of them is needed to load the package; each only switches on the part that uses it — see [Without Firebase](#without-firebase).

Installing next to **firebase-admin 13** in one command can leave two copies of
`@google-cloud/storage` (8 for this package, 7 for firebase-admin). Both work; run
`npm dedupe` once and npm keeps the one they share. firebase-admin 14.5 and later use
the same Storage as this package, so there is nothing to do.

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
  bucket: 'my-app.firebasestorage.app', // holds source maps AND attachments
})
```

One bucket serves both, under two default prefixes:

```
gs://my-app.firebasestorage.app/sourcemaps/{releaseId}/{bundle}.js.map
gs://my-app.firebasestorage.app/logAttachments/{logId}/{name}
```

Both the bucket and the prefix can be changed per half — see [Source maps](#source-maps)
for `sourceMaps: { bucket, prefix }`, and [Attachments](#attachments) for
`configureAttachments({ bucket, prefix })`. Omit `bucket` entirely and both fall back
to your project's default bucket.

**3. Wire the deploy script** — upload source maps and strip them from the hosting bundle as part of deploy. Merge into your root `package.json` scripts, keeping any existing flags like `--project`:

```json
"deploy": "export VITE_RELEASE_ID=$(git rev-parse --short HEAD) && npm run build && npx fsl upload-sourcemaps --backend=./functions --embed-sourcemaps && firebase deploy"
```

`fsl upload-sourcemaps` reads the bucket from `VITE_FIREBASE_STORAGE_BUCKET` (or `FIREBASE_STORAGE_BUCKET`) after loading `.env.local`. It uploads source maps to Cloud Storage, embeds a copy in `functions/sourcemaps/current/` for fast lookup, and deletes them from `dist/` so they are **not** served to browsers.

> **`VITE_RELEASE_ID`** ties a build to its source maps — the client tags every entry with it, and `upload-sourcemaps` stores maps under the matching path. Use the same value in both places (the deploy script above sets it once from the git SHA). Locally it defaults to `'dev'`, and no maps are uploaded — symbolication isn't needed in development.

**4. Verify it works** — prove the round trip before you trust it:

```ts
import { sendTestLog } from '@dasasian/firebase-structured-logger/client'

sendTestLog() // wire to a dev-only button; sends one error, one warning, one info
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

### If your backend is not Cloud Functions

Cloud Run, or any Node server you already run on Google Cloud. Two things differ from the browser
path above; everything else — breadcrumbs, labels, symbolication, the free fields — is
identical, and the entries land in the same stream in the same shape.

**Receive the logs over HTTP** instead of exporting a callable:

```ts
import express from 'express'
import { getAuth } from 'firebase-admin/auth'
import { initLogger, createHttpLogHandler } from '@dasasian/firebase-structured-logger/functions'

initLogger({ appId: 'my-app' })

const app = express()
app.use(express.json({ limit: '10mb' }))   // attachments ride in the body

app.post('/log', createHttpLogHandler({
  bucket: 'my-app.firebasestorage.app', // holds source maps AND attachments
  authorize: async (req) => {
    const header = String(req.headers.authorization ?? '')
    if (!header.startsWith('Bearer ')) return false
    try { await getAuth().verifyIdToken(header.slice(7)); return true } catch { return false }
  },
}))
```

The handler reads Node's request and response shapes. A framework that wraps them, like
Hono, needs a few lines of adapter:

```ts
import { Hono } from 'hono'
import { createHttpLogHandler } from '@dasasian/firebase-structured-logger/functions'

const app = new Hono()
const logHandler = createHttpLogHandler({ authorize })

app.on(['POST', 'OPTIONS'], '/log', async (c) => {
  const headers: Record<string, string> = {}
  let status = 200
  let body: string | undefined
  await logHandler(
    {
      method: c.req.method,
      headers: Object.fromEntries(c.req.raw.headers),
      body: await c.req.json().catch(() => null),
    },
    {
      get statusCode() { return status },
      set statusCode(v: number) { status = v },
      setHeader: (name, value) => { headers[name] = value },
      end: (b) => { body = b },
    },
  )
  return new Response(body ?? null, { status, headers })
})
```

**Point the client at it.** `logFunction` is any async function, so a `fetch` works:

```ts
initLogger({
  appId: 'my-app',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
  logFunction: async (payload) => {
    const res = await fetch('https://api.example.com/log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await auth.currentUser?.getIdToken()}`,
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`log rejected: ${res.status}`)
  },
})
```

#### Without Firebase

Nothing here needs a Firebase project — only a Google Cloud one. What changes:

- **The server has to run on Google Cloud** — Cloud Run, GKE, App Engine, or Compute
  Engine with the Ops Agent. Entries are written to stdout, and only there does stdout
  reach Cloud Logging. On AWS, Vercel or your own box they print and go nowhere.
- **The browser** needs no `firebase` package. `logFunction` is the `fetch` above; send
  whatever credential your app already uses.
- **`authorize`** checks your own session instead of a Firebase ID token — for example
  `authorize: (req) => sessions.isValid(req.headers.cookie)`.
- **Storage** has no Firebase default bucket to fall back to. Name one with `bucket`
  (it holds source maps and attachments), and give the service's account access to it.
  Or name none: embedded maps still resolve the current release, older releases stay
  minified, and attachments are dropped — the log says so once.
- **`fsl upload-sourcemaps --bucket`** works with any Cloud Storage bucket.
- **`withLogging` and `createClientLogFunction`** are Cloud Functions tools. Outside
  them, `logInfo` / `logError` and friends still write the same entries.

#### `authorize` is required, and that is deliberate

A callable gets Firebase's token check for free. An HTTP endpoint gets nothing, and an
open one writes to your Cloud Logging bill on anyone's say-so. There is no honest
default, so there isn't one.

It is a **gate, not an identity check**. The handler never reads `request.auth` — the
`userId` on a client entry is self-reported either way. Its job is keeping strangers out.

If something in front of it already did that work — a VPC, an API gateway, IAM — say so
at the call site:

```ts
createHttpLogHandler({ authorize: 'unauthenticated' })
```

A gate that throws counts as a rejection, not an opening.

#### What you need to know

- **Body parsing is yours.** Mount `express.json()` (or your framework's equivalent)
  before the handler. Raise its limit if you send attachments.
- **CORS** defaults to `*`, matching `cors: true` on the callable. Pass `allowOrigin` to
  name your origin — a browser cannot send cookies to a wildcard.
- **No `firebase-functions`? Not needed.** The entry point loads without it. Each entry is
  written as one line of JSON, which Cloud Run's log agent parses into the same Cloud
  Logging fields a function's would.
- **Trace correlation works**, and needs nothing from you on Cloud Run. The handler reads
  `X-Cloud-Trace-Context` or `traceparent` off the request, and asks the metadata server
  for the project id once, so a request's entries group with Cloud Run's own request log
  in Cloud Logging. Somewhere else — GKE, a VM — set `GOOGLE_CLOUD_PROJECT`; without it
  the trace id is still written, but does not join the platform's request log.
- **No `firebase-admin`? Also optional.** Storage is only needed for older releases'
  source maps and for attachments. With `firebase-admin` installed, its Storage and
  default bucket are used. Without it, name the bucket — `bucket` on the handler, or
  `configureAttachments({ bucket })` — and the service's own credentials are used.
- **No Storage bucket?** You do not need one. `fsl upload-sourcemaps --embed-sourcemaps`
  without `--bucket` embeds the current release's maps into your deploy and uploads
  nothing. The catch: only the **deployed** release can be symbolicated, because older
  ones live in a bucket there isn't one of. Errors from a previous release come back
  minified, and attachments are dropped — the entry is still written. With neither
  `firebase-admin` nor a bucket name, the log says so once at the first lookup.
- **Response codes:** `204` written, `400` malformed payload, `401` gate refused, `405`
  not a POST, `500` something else. The client treats a non-2xx as a throw.

## Check your setup

Most of what can go wrong here goes wrong silently: logs that never arrive, stacks that
never resolve, source code published next to the app. `fsl doctor` reads the project from
disk and says what it finds. It needs no network and no credentials, and it only reports
facts it can read from a file — it never guesses from your source code, so a finding is
never a false alarm.

```bash
npx fsl doctor                                     # Firebase: reads firebase.json
npx fsl doctor --backend=./server --dist=./dist    # anything else: say where things are
```

It prints a summary of how your setup will behave, then any findings:

```
Setup: Firebase — functions in ./functions, web build in ./dist

  Logging        firebase-functions write()              ok
  Trace ids      from each Cloud Functions trigger       ok
  Storage        firebase-admin, default bucket          ok
  Callable       createClientLogFunction available       ok

  ⚠ duplicate-storage   2 copies of @google-cloud/storage (8.2.0 for fsl, 7.22.0 for firebase-admin)
                        Fix: npm dedupe
```

| Id | Level | Means |
|---|---|---|
| `maps-published` | error | `.map` files are in the folder hosting serves — your source code is public |
| `node-version` | error | the backend's Node is below 22 |
| `callable-without-firebase-functions` | error | `firebase.json` has functions, but `firebase-functions` is not installed there |
| `could-not-check` | error | doctor could not read something it needed — including "run `npm install` first" |
| `duplicate-storage` | warning | two copies of `@google-cloud/storage`; fix with `npm dedupe` |
| `unsupported-peer` | warning | an installed peer (`firebase-admin`, `firebase-functions`, `firebase`) is outside the supported range |
| `embedded-maps-without-release` | warning | maps are embedded without a `.release` marker, so an older release can resolve against the wrong map |

**Exit code:** `0` when there are no errors, `1` when there is one. `--strict` also fails on
warnings, for teams that want a spotless setup; without it, a deliberate choice like
running with no Storage does not break CI. A check doctor could not run is always an
error, never a pass.

**`--json`** prints the same result for scripts and agents:

```json
{
  "setup": { "kind": "firebase", "backend": "./functions", "dist": "./dist",
             "logging": "firebase-functions", "trace": "trigger", "storage": "firebase-admin",
             "callable": true },
  "findings": [
    { "id": "duplicate-storage", "level": "warning",
      "message": "2 copies of @google-cloud/storage (8.2.0 for fsl, 7.22.0 for firebase-admin)",
      "fix": "npm dedupe" }
  ],
  "exitCode": 0
}
```

The ids and fields are part of the 1.0 API: scripts may depend on them.

What doctor does not check: anything set in your own code — the release id you pass to
`initLogger`, a bucket name passed to a handler. It says so ("bucket: set in code, not
checked") rather than guessing. [`fsl verify`](https://github.com/dasasian/firebase-structured-logger/issues/25),
planned after 1.0, will check those by sending a real log.

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

## Grouping, without a second product

Google Cloud already runs an error tracker in your project. **Error Reporting** watches
Cloud Logging, collapses repeats into issues, and gives you occurrence counts, a
resolution state — Open, Acknowledged, Resolved, Muted — notifications on new errors, and a
field to link your own issue tracker. It costs nothing beyond the logs you are already
writing, and it never sees anything outside your project.

It groups by exception type plus the **five top-most stack frames**. Which is why, for
almost every web app, it does nothing at all: those frames read `app-4f2a.js:1:98432`, they
change every release, and no two crashes ever look alike.

**We resolve the frames before the entry is written.** So yours read `Checkout.tsx:42`, and
they group:

```
TypeError: cannot read 'id' of undefined     ← "the discount broke"
TypeError: order is not iterable             ← "checkout is stuck"
                                                two reports, two messages,
                                                one line of code, one issue
```

Errors at `ERROR` and above carry `stack_trace` and a `serviceContext` naming your `appId`
and release, which is all Error Reporting needs. Nothing to enable in this package, and
nothing to configure.

Warnings stay out of it, and so does user feedback — an issue is something a person has to
resolve, and neither of those is a bug.

> Verified end to end against a real project: two errors with different messages from one
> source location land in a single group, attributed to the `appId` rather than to the
> function that wrote them, with the same group id across releases.

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

**Repeats are counted, not thrown away.** The usual answer to an error that fires 200 times
is to send the first few and drop the rest. This one sends 3 in full, counts the other 197,
and tells you when it started, when it stopped, which release and which user. Close the tab
and the count waits on the device for the next visit. See
[Repeats are counted, not dropped](#repeats-are-counted-not-dropped).

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

By default they share the bucket passed to `createClientLogFunction({ bucket })` — the
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

## Big entries

Cloud Functions and Cloud Run both cut a stdout/stderr log line at exactly **102,400 bytes**
(100 KiB) — measured live. Past that the entry does not arrive truncated-but-valid: it arrives
as broken plain text, with no `severity`, no labels, and nothing for Error Reporting to group.

The backend logger watches for this. An entry over 90 KiB is shortened before it is written —
breadcrumb data first, then other context, then the tail of a long stack (the top frames are
what Error Reporting groups on, so those survive longest), then long text fields, and label
values only as a last resort. `severity`, labels, the trace and `serviceContext` are never
touched.

The full, unshortened entry is saved to Cloud Storage as `fsl-overflow.json`, at the same
`logAttachments/{logId}/` path an ordinary attachment would use, whenever a bucket is
available — see [Attachments](#attachments). A shortened entry carries `labels.truncated="true"`,
and `labels.hasAttachments="true"` when the full entry was saved. With no Storage configured,
the entry is still shortened; the original is lost, and the process warns once, not per entry.

## Volume controls

Several gates decide whether a log is written. All have defaults, and the defaults
hold things back — so this is worth reading before you conclude something is broken.

| Gate | Default | Where |
|---|---|---|
| Log limit | bursts of up to **50 logs**, then **one log recharges every 60 s**; the last **10** for errors only | client, per browser tab |
| Duplicates | **3** full copies of the same error, then counted and sent as a summary | client, per browser tab |
| Client severity floor | `WARNING` in production, `DEBUG` in dev | client, `minSeverity` |
| Server severity floor | `WARNING` in production, `DEBUG` in the emulator | function, `minSeverity` |
| Function concurrency | `maxInstances: 1` on `createClientLogFunction` | function |

```ts
initLogger({
  appId: 'my-app',
  releaseId,
  logFunction,
  minSeverity: 'INFO',
  rateLimitOptions: {
    burstLimit: 50,              // how many logs can go at once
    rechargeSecondsPerLog: 60,   // after a burst, one log recharges every 60 seconds
    reservedForErrors: 10,       // of the burst, how many only ERROR and above may use
    duplicateLimit: 3,       // full copies of one error before counting starts
    summaryIntervalMinutes: 60,
    summaryMaxAgeDays: 7,    // how long an unsent summary waits on the device
    maxPendingSummaries: 50,
  },
})
```

The client's production default comes from `process.env.NODE_ENV`, which Vite replaces at
build time. A `define: { 'process.env': {} }` in `vite.config` — common, to quiet a library
that expects Node — replaces the whole object instead, `NODE_ENV` reads as undefined, and
the floor is silently `DEBUG` in production. If your config has that line, pass
`minSeverity` explicitly. Stating it is the safe habit either way: it is the one default
here whose failure mode is a bill rather than a missing log.

### Bursts recharge

Each browser tab can send a burst of up to `burstLimit` logs (50). After that, one log
recharges every `rechargeSecondsPerLog` seconds (60) — one at a time, so a full burst takes
50 minutes to come back. A reload does not reset it: the tab keeps its count in
`sessionStorage`.

So a burst at start-up is fine, and a user who works in the app all afternoon is never
silenced for long. A bug that logs in a loop is still held to about 60 entries an hour per
user: 1,000 users stuck in such a loop for a working month stays around the 50 GiB of
Cloud Logging that each project gets free.

The last `reservedForErrors` logs (10) are kept for errors: warnings can use the burst down
to 10, and only `ERROR` and above can use the rest. A value over half of `burstLimit` is
capped at half, with one warning, so warnings always have room. A noisy warning cannot use up the room a crash needs.

### Repeats are counted, not dropped

Two errors are the same when the **message and the screen both match**, so the same error
on two different screens is kept apart. The first 3 are sent in full, with their stack and
breadcrumbs. After that the browser only counts them, and sends one summary:

```
WARNING  Repeated 197 more times: cart sync failed
         labels.repeatOf="<repeatKey of the first copy>"  labels.repeatCount="197"
         labels.firstSeen="…"  labels.lastSeen="…"
```

The same count and window are in the entry's body, under `context.repeat`, so a summary is
filed as JSON like every other entry and a search on `jsonPayload.message` finds it.

The browser never learns the server's `logId` for the first copy — `writeLog` assigns it
after the log has already left the tab. So each full copy instead carries its own
`labels.repeatKey`, a client-side id, and the summary's `repeatOf` points at that instead:
query `labels.repeatKey="…" OR labels.repeatOf="…"` to find a full copy and its summary
together.

A summary is sent once an hour, when the tab is hidden, and once at startup for anything
a previous visit left queued. It is keyed by the error, the `releaseId` and the `userId`,
so two releases or two people on one computer are never counted together. Its entry is
timestamped at `lastSeen`, not at the time it was sent.

The summary's own labels are `appId`, `releaseId`, `userId`, `screen` and `errorType` — from
the time the errors happened, not from whoever's tab eventually sends it — plus
`repeatOf`/`repeatCount`/`firstSeen`/`lastSeen`/`sentLate`. Everything else about the error —
browser, platform, breadcrumbs, the stack — is not repeated here; it is already on the full
copies `repeatOf` points back to.

Unsent summaries are kept in `localStorage`, so closing the tab does not lose them: the
next visit sends them, marked `labels.sentLate="true"`. A summary is only removed from that
queue once it has actually been sent — a failed attempt (offline, or the tab closing right
after it was queued) leaves it for the next flush or the next visit to retry, never twice.
At most 50 wait, and any older than 7 days are deleted rather than sent — they are error
messages, and may hold personal data.

A summary is a `WARNING` with no stack, so Cloud Error Reporting sees the 3 full copies and
not the summary. For the true count, add up `labels.repeatCount` in Cloud Logging.

Summaries do not count against the burst. There is at most one per error, per release, per user,
per hour.

### What a dropped log looks like

The two rate limits say so in the browser console:

```
[fsl] Duplicate counted for the next summary: TypeError: cannot read 'id' | checkout
[fsl] Log limit reached — recharging, next log in about a minute
[fsl] Log limit: only errors can use the reserved logs now
```

**The severity floors are silent.** Both of them — the client's `minSeverity` and the
function's `minSeverity` — simply return, with nothing written and nothing logged about it.

So if an entry never arrived and there is no `[fsl]` warning in the console, it was a floor,
not a limit. In production both default to `WARNING`, which drops `DEBUG`, `INFO` and
`NOTICE` on the way out of the browser *and* again on the way into Cloud Logging — an
`INFO` you expected to see has two places it can vanish.

`maxInstances: 1` is a deliberate cost guard on what is usually the busiest function in the
system. Raise it (`createClientLogFunction({ bucket, maxInstances: 5 })`) if you are
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
| `labels.truncated="true"` | entries shortened to fit — the full copy is `fsl-overflow.json` |
| `labels.repeatKey="<key>" OR labels.repeatOf="<key>"` | one repeating error: its full copies and its summaries |
| `labels.sentLate="true"` | repeat summaries sent on a later visit |

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
`sendFeedback`, `sendTestLog`, `addBreadcrumb`, `bc`.

**Renamed in 1.0.** The old names still work in 1.x, each with a one-time console warning,
and are removed in 2.0:

| Old | New |
|---|---|
| `minLogLevel` (client `initLogger`) | `minSeverity` |
| `bucketName` (`createClientLogHandler`, `createClientLogFunction`, `createHttpLogHandler`) | `bucket` |
| `rateLimitOptions.sessionLimit` | `rateLimitOptions.burstLimit` |
| `rateLimitOptions.refillPerMinute` | `rateLimitOptions.rechargeSecondsPerLog` (seconds, not a rate: `60 / refillPerMinute`) |
| `rateLimitOptions.errorReserve` (a share) | `rateLimitOptions.reservedForErrors` (a count: `errorReserve × burstLimit`) |
| type `ClientLogRequest` | type `LogRequest` |
| `triggerTestLog()` | `sendTestLog()` |
| `fsl upload-sourcemaps --functions=<dir>` | `--backend=<dir>` (it is not only for Cloud Functions) |

`Logger` is exported as a **type only** — the client logger is a session singleton, so
annotate with `Logger<MyAppLabels>` and construct with `initLogger()`. A second instance
would silently share breadcrumbs, screen and the rate-limit budget while looking independent.


### Functions

```ts
initLogger({ appId, logLocalDir?, minSeverity?, logMaxRecordsPerFile?, logMaxRotatedFiles? })

withLogging(options | (request) => options, handler)
getLogger()                       // the current request's writer, or an anonymous fallback
logError / logWarn / logInfo / logDebug (message, labels?, context?, attachments?)

configureAttachments({ bucket?, prefix? })    // once, at module load — see Attachments

// Receiving client logs. All three take the same source-map config:
//   { bucket?, sourceMaps?: { bucket?, prefix? } }
createClientLogFunction({ …, cors?, maxInstances? })   // a ready-to-export callable
createHttpLogHandler({ …, authorize, allowOrigin? })   // an (req, res) handler for Express etc.
createClientLogHandler({ … })                          // the bare handler, wrap it yourself
```

Backend log methods also accept an optional `attachments` (`Record<string, string | Buffer>`).

`createClientLogHandler` takes `{ data: LogPayload }` — the minimum it reads — and throws
`ClientLogError` with a `code` of `'invalid-argument'` or `'internal'`. The two wrappers above
translate that: the callable into an `HttpsError`, the HTTP handler into a status code. Use the
bare handler only if you are wrapping it in something else yourself.

### CLI (`fsl`)

```bash
# Upload source maps to Cloud Storage and strip local .map files (run in deploy)
npx fsl upload-sourcemaps --backend=./functions --embed-sourcemaps

# Same, to a bucket and prefix of your choosing — tell the reader the same values
npx fsl upload-sourcemaps --backend=./functions --embed-sourcemaps --bucket=my-maps --prefix=fsl-maps

# No bucket at all: embed the current release, upload nothing
npx fsl upload-sourcemaps --backend=./backend --embed-sourcemaps

# Check the setup from disk — no network, no credentials (see "Check your setup")
npx fsl doctor
npx fsl doctor --backend=./server --dist=./dist   # no firebase.json to read
npx fsl doctor --strict --json                   # CI: fail on warnings too, machine-readable

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

Maps are stored at `gs://<bucket>/sourcemaps/{releaseId}/{filename}.map` and loaded by whichever log handler you deployed — the callable or the HTTP one — during symbolication.

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

## This is a hard problem

Not a difficult one — the pieces are all small. A hard one, in that the ways it goes wrong
are invisible until they aren't, and each is discovered by watching production do something
strange rather than by reading a doc.

Some of what is already handled here, all of it learned the expensive way:

- **Entry labels have to be emitted under `logging.googleapis.com/labels`.** Anywhere else
  and they land inside the payload, so `labels.appId="…"` matches nothing. The logs look
  perfect and cannot be filtered. Only a deployed run reveals it.
- **`AsyncLocalStorage.enterWith()` never unwinds.** A request's `userId` outlives the
  request, and the next handler on a warm instance inherits whichever user came before.
- **Source maps left in `dist/` are your source code, published.** Uploading them is the
  easy half; keeping them off the web server is the half people forget.
- **An unrecognised severity throws inside the write**, the entry is lost with no
  diagnostic, and it slips past the severity floor on the way there.
- **A trailing slash on a Storage prefix is a different object.** `fsl//r7/app.js.map` is
  not `fsl/r7/app.js.map`, and nothing collapses it — so the writer and reader silently
  disagree over a typo.
- **Checking a rate limit and spending it as two calls double-counts**, quietly making a
  configured budget of 50 a budget of 25.
- **A fixed budget goes silent in a long session.** 50 logs per page load is spent by
  mid-morning in an app someone keeps open all day, and the crash at lunch is never sent.
  A budget that refills, with a share kept for errors, does not have that shape.
- **An old stack naming a bundle that still exists** resolves against the current release's
  map, giving line numbers that are confidently wrong — worse than none, because nothing
  signals it.
- **`@google-cloud/logging` does not surface `errorGroups`.** Read grouping through the
  client library and you will conclude, wrongly, that nothing grouped.

Every one of those is fixed here, and each has a test that fails if it comes back. That is
the point: you would have found them one at a time, in production, over months.

The list is not finished. It grows every time this is run against something real, and the
honest pitch is not that this package is complete — it plainly isn't — but that someone is
still walking into these and fixing them. Code you wrote yourself is frozen the day you
write it.

Decide for yourself whether that is worth a dependency.

## What this is not

**A product of ours.** The grouping above is Google's Error Reporting, running in your
project — we make its input legible, we do not build or run it. If it changes, you are
downstream of that, the same as you already are for Cloud Logging.

**A triage tool with a console.** There is no assignment, no ownership, no dashboard of
ours. What exists is Google's console, plus whatever queries you write.

There are hosted error trackers that do all of that, and do it well. The trade is worth
stating plainly, because it is the whole reason to choose this instead.

**Nothing leaves your project.** Every entry, every breadcrumb, every screenshot stays in
the Google Cloud project you already own, under your own IAM and your own retention rules.
No third party receives it, no third party stores it, and there is no data-processing
agreement to negotiate because there is no processor.

That matters most where it usually matters: **breadcrumbs and attachments carry what a user
was actually doing**, and a screenshot of a checkout page is not something everyone is free
to hand to a vendor. If you are in health, finance, education, or anywhere a contract names
where data may live, that is not a preference — it is the decision.

What you give up is a polished product: no vendor UI, no onboarding flow, no support
contract, no assignment workflow. What you get is every frontend and backend event in one
stream you already own, in one query language, grouped by a console that came with the
project.

## License

MIT © Dasasian
