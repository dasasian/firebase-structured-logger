# /logs — Logging Validation Skill

Validate frontend and backend logging implementation for a given file.

---

## Phase 0 — Detect File Type

Identify whether the target file is frontend or backend:

**Frontend:** path starts with `src/`, imports from `firebase-structured-logger/client`, uses `logError/logWarn/logInfo/logDebug` or `bc.*`
**Backend:** path starts with `functions/src/`, imports from `firebase-structured-logger/functions`, uses `withLogging/getLogger/logError/logWarn/logInfo/logDebug`

---

## Phase 1 — Delegate to Explore Agent

**Never analyze directly — always delegate to preserve main conversation context.**

Build a task for the Explore agent:

```
Read these files:
1. src/main.tsx (or app entry point) — find initLogger<AppLabels>() call, identify AppLabels type name
2. The AppLabels type definition file — read all label field names
3. [TARGET_FILE] — the file to analyze

File type: [FRONTEND|BACKEND]

Report back:
- AppLabels type name and all its fields
- For BACKEND: also note which AppLabels fields appear in request.data or function params
- Full contents of the target file with line numbers
```

---

## Phase 2 — Analyze

Using the Explore agent's output, check the target file against the rules below.

---

### Frontend Rules

**Imports**
- Must use `logError/logWarn/logInfo/logDebug` from the project's logger utility (e.g. `src/utils/logger.ts`)
- Must use `bc` from `firebase-structured-logger/client` for breadcrumbs
- Never use `console.error()` directly — always use the logger

**Error paths**
- Every `catch` block must call `logError`
- `logError` accepts `unknown` — never cast with `as Error`
- Do not pass `errorType` explicitly unless overriding the auto-derived value from `error.name`

**Breadcrumbs**

Breadcrumbs reconstruct what the user was doing before an error — a session timeline, not just a wrapper around service calls. They belong primarily in components and screens, not service files.

UX-layer breadcrumbs to check for (flag if missing):
- Screen/route changes → `bc.nav('ScreenName')`
- Modal open/close → `bc.action('open_item_modal', { itemId })`
- Tab switches → `bc.action('switch_tab', { tab })`
- Explicit user decisions → `bc.action('merge_chosen')`, `bc.action('discard_changes')`
- Scan/camera events → `bc.action('barcode_scanned', { barcode })`

Service-layer breadcrumbs (secondary — useful but not sufficient on their own):
- Before a Firestore/API call → `bc.action('save_item', { itemId })`
- On error → `bc.error('save_failed', { itemId })`

**A component file with no UX-layer breadcrumbs is almost certainly missing them. A service file with only service-layer breadcrumbs may be fine.**

API:
- `bc.action(name: string, data?)` — user-initiated operations and decisions
- `bc.state(name: string, data?)` — significant state changes
- `bc.nav(screen: string)` — screen/route changes
- `bc.error(type: string, data?)` — when an error occurs

**Label completeness**
- For each function, check which `AppLabels` fields are in scope as variables
- Flag any that are not passed to the log call

**Rate limiting**
- Never log inside loops
- Never log on every keystroke or render

**PII**
- No email, name, address in labels or context
- `userId` is OK; full user objects are not

---

### Backend Rules

**Imports**
- Must import from `firebase-structured-logger/functions`
- Use `logError/logWarn/logInfo/logDebug` — never `console.log/console.error` directly

**`withLogging` — mandatory wrapper on every handler**
- Every `onCall` handler must be wrapped: `onCall(withLogging<AppLabels>({ functionName, labels }, handler))`
- Auto-seeds `userId` and `functionName` — do not pass these manually in labels
- Any `AppLabels` fields present in `request.data` need the callback form, which is evaluated per request: `withLogging<AppLabels>((request) => ({ functionName, labels: { orgId: request.data.orgId } }), handler)`
- Flag an unwrapped handler as a critical violation
- Flag `initRequestLogger` as a critical violation — it was removed in 0.6.0. It bound the
  scope with `enterWith()`, which never unwinds, so a request's labels outlived the request
  and any later handler that did *not* call it inherited whichever user last touched the
  warm instance. `withLogging` uses `run()`, which restores the previous scope when the
  handler settles.

**Error paths**
- Every `catch` block must call `logError`
- `logError` accepts `unknown` — never cast with `as Error`
- Do not pass `errorType` explicitly unless overriding the auto-derived value from `error.name`

**Label completeness**
- For each log call, check which `AppLabels` fields are in scope
- Fields already seeded via `withLogging` labels do not need repeating
- Flag any in-scope fields not seeded at entry or passed on the log call

**PII**
- Same rules as frontend

---

## Output Format

Report in three sections:

### Violations
```
Line <N>: <description>
```

### Missing Logging
```
Line <N>: <what should be logged and why>
```

### Label Completeness
```
Function <name>: missing labels [<label1>, <label2>] — these entities are in scope
```

If no issues found in a section, write "None."

---

## Phase 3 — Fix

When asked to fix violations found in Phase 2, use the FSL API Reference below. Do not read `firebase-structured-logger` source files — the reference is authoritative.

---

## FSL API Reference

### Frontend
Import from project logger utility (e.g. `src/utils/logger.ts`):
```ts
logError(raw: unknown, labels?: Partial<AppLabels>, context?: Record<string, unknown>, attachments?: Record<string, Blob | File | string>): Promise<void>
logWarn(message: string, labels?: Partial<AppLabels>, context?: Record<string, unknown>, attachments?: Record<string, Blob | File | string>): Promise<void>
logInfo(message: string, labels?: Partial<AppLabels>, context?: Record<string, unknown>, attachments?: Record<string, Blob | File | string>): Promise<void>
logDebug(message: string, labels?: Partial<AppLabels>, context?: Record<string, unknown>, attachments?: Record<string, Blob | File | string>): Promise<void>
```

Import `bc` from `firebase-structured-logger/client`:
```ts
bc.action(name: string, data?: Record<string, unknown>): void  // before operations
bc.state(name: string, data?: Record<string, unknown>): void   // on state changes
bc.nav(screen: string): void                                   // on navigation
bc.error(type: string, data?: Record<string, unknown>): void   // on errors
```

Import `sendFeedback` from `firebase-structured-logger/client`:
```ts
sendFeedback(text: string, extras?: { labels?: Partial<AppLabels>; attachments?: Record<string, Blob | File | string> }): void
```
- For what a user reports, not what the code catches — a wrong total, a button that did
  nothing. Wire it to a feedback form, never to a `catch` block.
- Writes at `NOTICE` with `labels.feedback="true"`, and carries the current breadcrumbs,
  screen and user labels automatically.
- Exempt from the severity floor and the rate limiter. Returns nothing — tell the user
  thanks; if the app needs correlation, pass its own id in `labels`.

### Backend
Import from `firebase-structured-logger/functions`:
```ts
// Wrap every onCall handler — auto-seeds userId and functionName, and unwinds
// the scope when the handler settles
export const myFunc = onCall(
  withLogging<AppLabels>(
    (request) => ({ functionName: 'myFunc', labels: { organizationId: request.data.organizationId } }),
    async (request) => { /* logError/logWarn/logInfo/logDebug work in here */ },
  ),
)

logError(raw: unknown, labels?: Record<string, string | undefined>, context?: Record<string, unknown>, attachments?: Record<string, string | Buffer>): void
logWarn(message: string, labels?: Record<string, string | undefined>, context?: Record<string, unknown>, attachments?: Record<string, string | Buffer>): void
logInfo(message: string, labels?: Record<string, string | undefined>, context?: Record<string, unknown>, attachments?: Record<string, string | Buffer>): void
logDebug(message: string, labels?: Record<string, string | undefined>, context?: Record<string, unknown>, attachments?: Record<string, string | Buffer>): void
```

### Key behaviours
- `logError` auto-derives `errorType` from `error.name` — only pass explicitly to override (e.g. `{ errorType: 'DatabaseError' }`)
- `logError` accepts `unknown` — never cast with `as Error`
- `withLogging` auto-seeds `userId` (from `request.auth.uid`) and `functionName` — do not pass these in labels
- `getLogger()` outside a wrapped handler returns an anonymous writer, not stale labels
- Every log entry includes `labels.logId` (ULID) — if `attachments` are passed, they are uploaded to GCS at `logAttachments/{logId}/{name}` fire-and-forget; upload failure never blocks the log entry
- When catching an error, check if there are attachments in scope (images, file snapshots, captured data) that would help reproduce or diagnose it — if so, pass them via `attachments`
