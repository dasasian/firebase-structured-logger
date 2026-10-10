# fsl capabilities

Package: `@dasasian/firebase-structured-logger`. Entry points: `/client`, `/client/navigation`, `/client/navigation/react-router`, `/client/navigation/vue-router`, `/client/views`, `/client/actions`, `/client/timing`, `/functions`, `/testing`, and the `fsl` CLI.

Each section below has the same four headings: Gives, Fits when, Add, Mistakes. A section is complete on its own.

## Error capture

### Gives
- Uncaught errors and unhandled rejections from the browser, written to Cloud Logging with the source file and line resolved from source maps.
- Errors React or Vue catch, which never reach `window`: `onCaughtError: handleReactError` on `createRoot` and `app.config.errorHandler = handleVueError`, each logged once as an `ERROR`.
- Labels on every entry: `appId`, `releaseId`, `screen`, `platform`, `browser`, `errorType`, `userId` (after `setUser`), the last 50 breadcrumbs.
- Rate limits: 50-log burst per tab, 3 full copies of a repeated error, then a counted summary.

### Fits when
- The app imports from `firebase/functions` or has a `fetch` to its own backend, and has no `initLogger(` call.
- `window.onerror`, `addEventListener('error'` or `unhandledrejection` handlers that only `console.error`.
- `catch` blocks that swallow an error and log nothing.
- `createRoot(` with no `onCaughtError` (any React app: a data router always adds its own error boundary), or `createApp(` with no `app.config.errorHandler`.

### Add
```ts
import { initLogger, setupGlobalErrorHandler } from '@dasasian/firebase-structured-logger/client'

export const logger = initLogger({
  appId: 'my-app',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
  logFunction: async (payload) => {
    await fetch('/log', { method: 'POST', body: JSON.stringify(payload) })
  },
})

setupGlobalErrorHandler()
```
React 19 and Vue 3 catch errors before `window` sees them. Hand them to fsl where the framework catches them:
```ts
import { handleReactError, handleVueError } from '@dasasian/firebase-structured-logger/client'

createRoot(document.getElementById('root')!, { onCaughtError: handleReactError }).render(<App />)

app.config.errorHandler = handleVueError
```
The receiving end is `createClientLogFunction` or `createHttpLogHandler` from `@dasasian/firebase-structured-logger/functions`.

### Mistakes
- `initLogger(` without `minSeverity` in a Vite app whose config has `define: { 'process.env': {} }` → `NODE_ENV` reads undefined and the floor becomes `DEBUG` in production → pass `minSeverity` explicitly.
- `createRoot(` without `onCaughtError` → React's default error page, every `errorElement` and every `ErrorBoundary` catch the error, so `window` never sees it and nothing is logged → pass `onCaughtError: handleReactError`.
- An `errorElement` or error boundary that calls `logger.error` → the error is also logged by `onCaughtError`, so it appears twice → show the UI and do not log.
- `createApp(` without `app.config.errorHandler` → Vue's component errors are not logged → assign `app.config.errorHandler = handleVueError`.
- A second `new Logger(` or a second `initLogger(` expected to be independent → the client logger is one session singleton → call `initLogger` once and import the returned logger.
- `logger.info(` expected in production logs with no `minSeverity: 'INFO'` → the default floor in production is `WARNING` on the client and on the function → set `minSeverity` on both sides.
- `minLogLevel`, `bucketName`, `triggerTestLog(`, `rateLimitOptions.sessionLimit`, `refillPerMinute`, `errorReserve` → renamed in 1.0, removed in 2.0 → use `minSeverity`, `bucket`, `sendTestLog`, `burstLimit`, `rechargeSecondsPerLog`, `reservedForErrors`.
- No call to `sendTestLog` ever made → nothing proves the round trip → wire `sendTestLog()` to a dev-only button and look for `labels.errorType="fsl-verify"`.

## Breadcrumbs

### Gives
- A trail of the last 50 steps (at most 5 minutes old), attached to every error and every piece of feedback. Held in memory only.
- `bc.action`, `bc.state`, `bc.handledError`.

### Fits when
- Click or submit handlers that call something that can fail (`await`, `fetch(`, `httpsCallable(`) with no `bc.action(` before it.
- `catch` blocks that handle an error, do not log it, and continue.
- Existing `bc.nav(` or `bc.error(` calls.
- `<button`, `<form`, `<select` or `onClick=` / `@click=` handlers whose action matters to the path and carries no data: mark them with `data-fsl-action` instead of calling `bc.action(`.

### Add
```ts
import { bc } from '@dasasian/firebase-structured-logger/client'

bc.action('apply_discount', { code: 'SAVE10' })
bc.state('total_recalculated', { total: 42 })
bc.handledError('draft_save_failed', { attempt: 1 })
```

### Mistakes
- `bc.error(` → deprecated, removed in 2.0 → `bc.handledError(` and only for an error that was handled and not logged.
- `bc.handledError(` next to `logger.error(` for the same error → an error that is logged is already in the logs in time order → remove the breadcrumb.
- `bc.action('x', { email, token, card })` → breadcrumb `data` is written to the logs verbatim → record the step, not the data.
- `bc.nav(` anywhere → deprecated; ignored when navigation is on → remove it; navigation records pages.

## Navigation

### Gives
- One `nav` breadcrumb per page change, and the labels `screen`, `route` (pattern, e.g. `/orders/:id/items`), `path` (real path, e.g. `/orders/1042/items`) on every entry.
- Query string never recorded; fragment recorded only when it is a route.
- Route errors, logged once each after the page is recorded, with the labels of the page they happened on: with React Router, a loader or action that throws or returns an error response (an `Error` or 5xx as `ERROR`, a 4xx such as 404 as `WARNING`); with Vue Router, a guard that throws or a lazy route that fails to load (`ERROR`). `errorType` is `RouteError`.
- Two ways in, one source runs at a time: `enableNavigation()` wraps `history.pushState` and `replaceState`; a router adapter listens to the router. An adapter wins over `enableNavigation()`.

### Fits when
- `createBrowserRouter(`, `createMemoryRouter(`, `RouterProvider` from `react-router` (React Router 6.4+ or 7, data router) → use the React Router adapter.
- `createRouter(` from `vue-router` → use the Vue Router adapter.
- `<BrowserRouter>` or any other router, or hand-rolled `history.pushState` → use `enableNavigation()`.
- `bc.nav(`, `setScreen(` or `logger.setScreen(` calls, or a `useEffect` that records the page on location change.

### Add
React Router data router:
```ts
import { enableReactRouterNavigation } from '@dasasian/firebase-structured-logger/client/navigation/react-router'

enableReactRouterNavigation(router)
```
`screen` comes from `handle: { screen: 'OrderItems' }` on a route; without it `screen` is the route pattern.

Vue Router 4:
```ts
import { enableVueRouterNavigation } from '@dasasian/firebase-structured-logger/client/navigation/vue-router'

enableVueRouterNavigation(router)
```
`screen` comes from the route `name`.

No router adapter applies:
```ts
import { enableNavigation } from '@dasasian/firebase-structured-logger/client/navigation'

enableNavigation()
```

### Mistakes
- `bc.nav(` while an adapter or `enableNavigation()` is on → records the same page twice, so fsl ignores it and warns → delete the call.
- `setScreen(` or `logger.setScreen(` while navigation is on → same, ignored with a warning → delete the call and name the screen with `handle: { screen }` (React Router) or the route `name` (Vue Router).
- A `<Navigate>` redirect with a hand-written `bc.action(` or `navigatedTo(` beside it → the adapter already records the page that holds the `<Navigate>` and the page it ends on, so the hand-written call adds a third breadcrumb → delete the call.
- Per-route hand-written `navigatedTo(` calls in an app with a router → the adapter already sees every route change → use the adapter and remove them.
- Route errors expected from `<BrowserRouter>` or `enableNavigation()` → they have no loaders or actions, so there is nothing to log → use a data router (`createBrowserRouter`) with the adapter.
- `enableNavigation()` and an adapter both called → the adapter wins and a warning is printed → keep only the adapter.
- `enableReactRouterNavigation(` called with `<BrowserRouter>` (no data router) → the adapter reads `router.subscribe` and `router.state`, which only a data router has → use `enableNavigation()`, or move to `createBrowserRouter` and then use the adapter.
- A `labelsFor` passed together with an adapter → `labelsFor` does not apply to adapters → use the adapter's `adjust` option.
- A `:param` route or a nested route given a hand-written `screen` per URL → `route` is the joined pattern, so every id is one page → remove it.
- `routeFor`, `cleanPath`, `path: false` options, the `routeSource` label → deprecated, removed in 2.0 → `labelsFor`.

## Pages without a URL change

### Gives
- The same `nav` breadcrumb and `screen`, `route`, `path` labels as navigation, for a page change that did not change the URL.

### Fits when
- State-driven screen switching: `useState('home')` with a `switch (screen)` render, a `currentView` or `step` variable swapped without `pushState`.
- Wizards and tab shells where the address bar never changes.
- `bc.nav(` or `setScreen(` calls (both deprecated).

### Add
```ts
import { navigatedTo } from '@dasasian/firebase-structured-logger/client/navigation'

navigatedTo('Checkout')
```
Call it at each screen change. Optional second argument: `{ route, path }`.

### Mistakes
- `navigatedTo(` called for a change that also changes the URL while `enableNavigation()` or an adapter is on → one page change is one breadcrumb → remove the call.
- `navigatedTo(` for a dialog, tab or step inside a page → that is a view, not a page → mark it with `data-fsl-view` and call `enableViews()` from `@dasasian/firebase-structured-logger/client/views`.
- `bc.nav(` / `setScreen(` → deprecated → `navigatedTo(`.

## Views

### Gives
- A `view` label on every browser entry: the names of the visible `data-fsl-view` marks, in page order, joined with ` › ` (for example `payment › Attachment`). No visible mark, no label.
- Read when the entry is written. No open or close calls.

### Fits when
- Dialog, modal, drawer or popover components: `role="dialog"`, `<dialog`, `aria-modal`, `Modal`, `Dialog`, `Drawer` in JSX or templates.
- Tab panels (`role="tabpanel"`) and wizard step containers.
- No `data-fsl-view` attribute anywhere in the markup.

### Add
```ts
import { enableViews } from '@dasasian/firebase-structured-logger/client/views'

enableViews()
```
```html
<section data-fsl-view="payment">…</section>
<div class="modal" data-fsl-view="Attachment">…</div>
```
Put the mark in the one shared modal component and pass the name in as a prop, so every dialog is marked once.

### Mistakes
- A dialog, modal or drawer element with no `data-fsl-view` while `enableViews()` is called → the dialog is invisible to the `view` label → add the mark, once, in the shared modal component.
- `` data-fsl-view={`Order ${order.id}`} `` or any mark whose value is a record id, name, email or free text → the value reaches every log entry as user data → use a value from a fixed set of code names, as in `` data-fsl-view={`Tab ${tab.name}`} `` where `tab.name` is one of `"details"`, `"history"`.
- A mark on every row of a list → the label becomes `row › row › row` → mark the list once.
- `bc.action(` used to say a dialog is open → a view is a label, not a breadcrumb → mark the dialog; keep `bc.action` for the click that opened it.
- `enableViews` imported from `/client` → it lives in its own entry point → import from `/client/views`.
- Marks inside a web component's shadow root → not found → move the mark outside the shadow root.
- `enableViews()` never called but `data-fsl-view` present → the marks are ignored → call it once at startup.

## Marked actions

### Gives
- One `action` breadcrumb per user action on an element marked `data-fsl-action`, with the attribute's value as its name and no `data`. The same breadcrumb `bc.action(name)` records, recorded before the app's own handler runs.
- The marked element decides its event: `<form>` on submit, `<select>`, `<input>` and `<textarea>` on change, anything else on click. Enter on a button is a click.
- The nearest mark wins: a click on an icon inside a marked button records the button's name. Marks inside open shadow roots are found.

### Fits when
- `<button`, `<a `, `<form`, `<select`, `<input`, `<textarea` and `role="button"` elements with `onClick=`, `@click=`, `(click)=`, `onSubmit=`, `@submit=`, `onChange=` or `@change=` handlers.
- Handlers that start something that can fail (`await`, `fetch(`, `httpsCallable(`) and carry no data worth recording.
- No `data-fsl-action` attribute anywhere in the markup.

### Add
```ts
import { enableActions } from '@dasasian/firebase-structured-logger/client/actions'

enableActions()
```
```html
<button data-fsl-action="apply_discount">Apply</button>
<select data-fsl-action="choose_shipping">…</select>
<form data-fsl-action="checkout_submitted">…</form>
```
Mark the element that gets the event, once, in the shared button or form component, and pass the name in as a prop.

### Mistakes
- `` data-fsl-action={`apply ${code}`} `` or any mark whose value is a code, name, email, id or free text → the value reaches every error's trail as user data → use a fixed name such as `apply_discount`; for data, call `bc.action('apply_discount', { code })` in the handler.
- A mark on a wrapper around a `<form>`, `<select>` or `<input>` → the wrapper counts on click while the control counts on change, so the change is not the wrapper's action → put the mark on the control or the form itself.
- A mark on a `<form>` plus marks on its submit button → the submit is recorded for the form and the button's click is recorded as a second action → mark the form only.
- A mark on every row, option or key press of a list → the 50-entry trail fills with repeats and pushes out the steps that matter → mark the controls that start something.
- `bc.action('x')` in a handler for an element that is also marked with `data-fsl-action="x"` → the action is recorded twice → keep only the mark, or keep `bc.action` for a call that has data.
- `enableActions` imported from `/client` → it lives in its own entry point → import from `/client/actions`.
- Marks inside a closed shadow root → not found → move the mark outside the closed root, or open the root.
- `enableActions()` never called but `data-fsl-action` present → the marks are ignored → call it once at startup.

## User and labels

### Gives
- `setUser(uid, extraLabels)` puts `userId` and the extra labels on every client entry until `clearUser()`. The backend writes `userId` from the verified `request.auth.uid`, so `labels.userId="…"` returns both halves.
- Three label scopes that merge, innermost wins: `initLogger`, `setUser`, the individual log call.
- One shared labels type used on both sides.

### Fits when
- An auth state listener: `onAuthStateChanged(`, `useAuth(`, a sign-in or sign-out handler.
- Log calls that repeat the same label (`orderId`, `organizationId`) in many places.
- An `AppLabels` or similar interface already exported from a shared file.

### Add
```ts
import { initLogger } from '@dasasian/firebase-structured-logger/client'

interface MyAppLabels {
  organizationId?: string
}

const logger = initLogger<MyAppLabels>({ appId: 'my-app' })

logger.setUser(uid, { organizationId })
logger.clearUser()
```
Call `setUser` on sign in and `clearUser` on sign out.

### Mistakes
- An auth listener that calls `setUser` on sign in and has no `clearUser` on sign out → the next person on the device inherits the previous `userId` → call `clearUser()` when the user is null.
- `userId` passed as a label on log calls → `setUser` already attaches it → remove it.
- Treating client `userId` as verified → it is self-reported by the browser → use it for debugging only; backend entries carry the verified uid.
- Email, name or phone in a label → labels are written to the logs verbatim → use an id.

## Release ids and source maps

### Gives
- `releaseId` on every entry, tied to the source maps uploaded for that build, so a minified stack resolves to `Checkout.tsx:42`.
- `fsl upload-sourcemaps` uploads the `.map` files to Cloud Storage, can embed the current release's maps into the backend deploy, and deletes the maps from `dist/`.

### Fits when
- `vite.config.ts` or `vite.config.js` present.
- `package.json` has a `deploy` script that runs `firebase deploy` without `fsl upload-sourcemaps`.
- `initLogger(` with `releaseId` missing or a literal string.
- `build.sourcemap` absent or `false` in the Vite config.

### Add
```ts
import { initLogger } from '@dasasian/firebase-structured-logger/client'

initLogger({
  appId: 'my-app',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
})
```
```bash
export VITE_RELEASE_ID=$(git rev-parse --short HEAD) && npm run build && npx fsl upload-sourcemaps --backend=./functions --embed-sourcemaps && firebase deploy
```
The Vite config needs `build: { sourcemap: true }`.

### Mistakes
- `.map` files left in the folder hosting serves → the source code is public → run `fsl upload-sourcemaps` before deploy; `fsl doctor` reports `maps-published`.
- A `releaseId` in `initLogger` that differs from the value used at upload → maps are not found, stacks stay minified → use the same variable in both.
- `--bucket` or `--prefix` on the upload with no matching `sourceMaps: { bucket, prefix }` on the receiving handler → the handler looks elsewhere and finds nothing → set both ends to the same values.
- `--functions=<dir>` on `upload-sourcemaps` → renamed → `--backend=<dir>`.
- `releaseId` hard-coded to a constant → a build is no longer tied to its own source maps → pass the git SHA.

## Attachments

### Gives
- A final `attachments` argument on every log method. Files go to Cloud Storage under `logAttachments/{logId}/{name}`, not into the entry. Entry labels `logId` and `hasAttachments="true"` locate them.
- Client types: `Record<string, Blob | File | string>`. Backend types: `Record<string, string | Buffer>`.

### Fits when
- Error handlers around a canvas, camera, file upload or large request: `toBlob(`, `new Blob(`, `JSON.stringify(` of a store or cart passed into a log label or `context`.
- Log calls with very large objects as `context`.

### Add
```ts
import { initLogger } from '@dasasian/firebase-structured-logger/client'

const logger = initLogger({ appId: 'my-app' })

logger.error(err, { orderId }, undefined, { photo: blob, state: JSON.stringify(cart) })
```
To store them in another bucket, call this once at module load in the functions entry file:
```ts
import { configureAttachments } from '@dasasian/firebase-structured-logger/functions'

configureAttachments({ bucket: 'my-app-user-content', prefix: 'evidence' })
```

### Mistakes
- A large payload placed in `context` or a label → a Cloud Logging entry over 256 KB fails to write → pass it as an attachment.
- `configureAttachments(` inside a request handler or passed per handler → it is global → call it once at module load.
- No bucket and no `firebase-admin` installed → attachments are dropped and the log says so once → name a `bucket` on the handler.
- No lifecycle rule on `logAttachments/` → nothing expires attachments → add a lifecycle rule.

## Feedback

### Gives
- `sendFeedback(text, options)` writes a `NOTICE` entry with the breadcrumb trail, `screen`, `userId`, `releaseId`, `platform`, `browser`, and optional attachments and labels. Marked `labels.feedback="true"`.
- No UI, returns nothing, exempt from the rate limiter and the severity floor, not sent to Error Reporting.

### Fits when
- A "report a problem", "send feedback" or "contact support" form or button.
- A `mailto:` link or a third-party widget used for bug reports.

### Add
```ts
import { sendFeedback } from '@dasasian/firebase-structured-logger/client'

sendFeedback(text, { attachments: { screenshot }, labels: { orderId } })
```

### Mistakes
- `logger.error(` or `logger.info(` used for what a person typed → feedback needs its own severity and exemptions → `sendFeedback(`.
- UI that waits for a reference id from `sendFeedback` → it returns nothing → show a thank-you and pass the app's own id as a label if correlation is needed.
- An alert on `labels.feedback` expecting it to fire at `WARNING` → feedback is `NOTICE`, below `WARNING` → query it by label.

## Timing traces

### Gives
- A `WARNING` when a named run or one of its steps passes its limit, or never finishes. A run inside its limits sends nothing. Hidden or paused runs are never judged.
- Labels `trace`, `run`, `slow` (`trace` or `step`), `step`, plus `timing` in the body.
- Same API on the client and on the server.

### Fits when
- A loading screen awaiting several things: `Promise.all([` of loaders at boot or on mount.
- Hand-written `performance.now()` or `Date.now()` subtraction logged with `console.log`.
- Reports of slow screens that produce no errors.

### Add
```ts
import { trace, configureTraces } from '@dasasian/firebase-structured-logger/client/timing'

configureTraces({ app_boot: { warnAfterMs: 8000, steps: { products: 3000 } } })

await trace('app_boot', async (boot) => {
  await Promise.all([
    boot.step('products', () => loadProducts()),
    boot.step('places', () => loadPlaces()),
  ])
})
```
For a flow spanning functions: `startTrace(name)`, then `.step(...)`, then `.end()`. On the server, import `trace`, `startTrace`, `configureTraces` from `@dasasian/firebase-structured-logger/functions`.

### Mistakes
- `trace(` for a name with no entry in `configureTraces(` → timed but never reported → add limits.
- `configureTraces(` called after the first run starts → limits are read when a run starts → call it at startup.
- A run name or step name built from a value (`` `load_${id}` ``) → names must be fixed → use a fixed name.
- `step(` after `end()` or a second `end()` → ignored → remove it.
- Using traces for percentiles or sampling → not supported → use a monitoring tool.

## Testing what an app logs

### Gives
- `captureEntries()` returns `{ logFunction, entries, clear(), settled() }`; `entries` are what the logger sends, after cleaning, size limits and the rate limiter.
- `resetSession()` empties the trail, current page, rate-limit budget, duplicate counts and pending summaries. Navigation and views stay enabled.

### Fits when
- Test files (`*.test.ts`, `*.test.tsx`, `*.spec.ts`) in an app that imports `@dasasian/firebase-structured-logger/client`.
- Tests that mock `fetch` or `httpsCallable` to inspect log payloads.

### Add
```ts
import { initLogger } from '@dasasian/firebase-structured-logger/client'
import { captureEntries, resetSession } from '@dasasian/firebase-structured-logger/testing'

const capture = captureEntries()
const logger = initLogger({ appId: 'test', logFunction: capture.logFunction })

beforeEach(() => {
  resetSession()
  capture.clear()
})

test('logs the probe', async () => {
  logger.info('probe')
  await capture.settled()
  const entry = capture.entries.findLast((e) => e.message === 'probe')
  expect(entry?.labels.appId).toBe('test')
})
```

### Mistakes
- `capture.entries` read right after a log call, with no `await capture.settled()` → an entry with attachments reaches `logFunction` only after its files are read → `await capture.settled()` first.
- `capture.entries[0]` or `entries.at(-1)` → the logger also sends its own entries, and a rate-limited entry is missing → find by message with `findLast`.
- No `resetSession()` in `beforeEach` → the 50-crumb trail and 50-entry budget carry over between tests → call it before each test.
- A test of `data-fsl-view` in a node environment → views need a DOM → use jsdom.
- `/testing` imported from application code → it is for test files only → import it in tests.

## Cloud Functions logger

### Gives
- `initLogger` for the backend, then `logInfo`, `logWarn`, `logError`, `logDebug` writing the same entry shape as the client.
- In the emulator, entries go to `{logLocalDir}/dev.jsonl` instead of Cloud Logging.

### Fits when
- `functions/` directory with `firebase.json` containing `"functions"`.
- `console.log(` or `console.error(` in `onCall`, `onRequest`, `onDocumentWritten` handlers.
- `import … from 'firebase-functions'` with no `@dasasian/firebase-structured-logger/functions` import.

### Add
```ts
import { initLogger, logInfo, logError } from '@dasasian/firebase-structured-logger/functions'

initLogger({ appId: 'my-app', logLocalDir: '../.fsl-logs' })

logInfo('started', { orderId })
logError(err, { orderId })
```
`initLogger` runs at module load in the functions entry file.

### Mistakes
- `logLocalDir` set to a folder inside the Functions source folder → the emulator restarts on every entry and a deploy uploads the files → point it outside, for example `'../.fsl-logs'`; `fsl doctor` reports `logs-inside-functions-source`.
- `initLogger(` missing in the functions entry file → the backend logger is not configured → call it at module load.
- `initLogger` imported from `/client` inside `functions/` → wrong half → import from `/functions`.
- `console.log(` left in handlers beside `logInfo(` → unstructured lines, no labels → replace with `logInfo(`.
- Node below 22 in `functions/package.json` `engines.node` or `firebase.json` `runtime` → unsupported → `nodejs22` or later; `fsl doctor` reports `node-version`.

## withLogging and createHttpLogHandler

### Gives
- `withLogging` binds `functionName`, the verified `userId` and any labels to everything logged inside one handler call; they cannot leak into another request.
- `createClientLogFunction` is a ready callable that receives browser logs. `createHttpLogHandler` is an `(req, res)` handler for Express or any Node server on Google Cloud, for backends that are not Cloud Functions.

### Fits when
- `onCall(`, `onSchedule(` or `onTaskDispatched(` handlers whose body is not wrapped in `withLogging(`.
- `export const logFrontendEvent` absent from the functions entry file, while the client sets `logFunction: httpsCallable(`.
- `express()` or `new Hono()` servers on Cloud Run with a client `fetch` to a `/log` path.

### Add
Cloud Functions:
```ts
import { withLogging, logInfo, createClientLogFunction } from '@dasasian/firebase-structured-logger/functions'

export const checkout = onCall(
  withLogging({ functionName: 'checkout' }, async (request) => {
    logInfo('started')
  }),
)

export const nightly = onSchedule(
  'every day 02:00',
  withLogging<AppLabels, ScheduledEvent>({ functionName: 'nightly' }, async (event) => {
    logInfo('started')
  }),
)

export const logFrontendEvent = createClientLogFunction({ bucket: 'my-app.firebasestorage.app' })
```
Cloud Run or any Node server:
```ts
import { createHttpLogHandler } from '@dasasian/firebase-structured-logger/functions'

app.use(express.json({ limit: '10mb' }))
app.post('/log', createHttpLogHandler({ authorize: async (req) => isSignedIn(req) }))
```

### Mistakes
- `createHttpLogHandler({` without `authorize` → required; an open endpoint writes to the log bill on anyone's say-so → pass a function, or `'unauthenticated'` only when a gateway or IAM already gates it.
- `createHttpLogHandler` mounted before `express.json()` → body parsing is the app's job → mount the parser first, with a limit that fits attachments.
- `withLogging` inside `onSchedule(` or `onTaskDispatched(` without the event type → `request` is typed as `CallableRequest` and `tsc` rejects it → pass `ScheduledEvent` (from `firebase-functions/v2/scheduler`) or `Request<Data>` (from `firebase-functions/v2/tasks`) as the second type argument.
- `withLogging` around an `onRequest(` handler → it takes one argument and `onRequest` handlers take `(req, res)` → leave it unwrapped.
- `withLogging` used outside Cloud Functions → it is a Cloud Functions tool → use `logInfo` and friends directly.
- `userId` passed as a label inside `withLogging` → taken from `request.auth.uid` already (absent in a schedule) → remove it.
- A handler that calls `logInfo(` with no `withLogging(` around it → entries carry no `functionName` or `userId` → wrap it.
- `maxInstances` raised on `createClientLogFunction` from reading the code alone → `maxInstances: 1` is the cost guard → raise it only when logs show dropped client entries.
