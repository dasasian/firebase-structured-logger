# /logs — Logging Validation Skill

Validate frontend and backend logging implementation for a given file.

---

## Phase 0 — Detect File Type

Identify whether the target file is frontend or backend:

**Frontend:** path starts with `src/`, imports from `firebase-structured-logger/client`, uses `logError/logWarn/logInfo/logDebug` or `bc.*`
**Backend:** path starts with `functions/src/`, imports from `firebase-structured-logger/functions`, uses `initRequestLogger/getLogger/logError/logWarn/logInfo/logDebug`

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
- `bc.action('name', data?)` — before user-initiated operations
- `bc.state('name', data?)` — on significant state changes
- `bc.nav('ScreenName')` — on screen/route changes
- `bc.error('type', data?)` — when an error occurs

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

**`initRequestLogger` — mandatory at function entry**
- Every `onCall` handler must call `initRequestLogger<AppLabels>(request, { functionName, labels })` as the first line
- Auto-seeds `userId` and `functionName` — do not pass these manually in labels
- Any `AppLabels` fields present in `request.data` or function params should be passed in `labels`
- Flag missing `initRequestLogger` as a critical violation

**Error paths**
- Every `catch` block must call `logError`
- `logError` accepts `unknown` — never cast with `as Error`
- Do not pass `errorType` explicitly unless overriding the auto-derived value from `error.name`

**Label completeness**
- For each log call, check which `AppLabels` fields are in scope
- Fields already seeded via `initRequestLogger` labels do not need repeating
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

## FSL API Reference

### Frontend
Import from project logger utility (e.g. `src/utils/logger.ts`):
```ts
logError(raw: unknown, labels?: Partial<AppLabels>, context?: Record<string, unknown>): Promise<void>
logWarn(message: string, labels?: Partial<AppLabels>, context?: Record<string, unknown>): Promise<void>
logInfo(message: string, labels?: Partial<AppLabels>, context?: Record<string, unknown>): Promise<void>
logDebug(message: string, labels?: Partial<AppLabels>, context?: Record<string, unknown>): Promise<void>
```

Import `bc` from `firebase-structured-logger/client`:
```ts
bc.action(name: string, data?: Record<string, unknown>): void  // before operations
bc.state(name: string, data?: Record<string, unknown>): void   // on state changes
bc.nav(screen: string): void                                   // on navigation
bc.error(type: string, data?: Record<string, unknown>): void   // on errors
```

### Backend
Import from `firebase-structured-logger/functions`:
```ts
// Call first in every onCall handler — auto-seeds userId and functionName
initRequestLogger<AppLabels>(request, { functionName: 'myFunc', labels: { organizationId: request.data.organizationId } })

logError(raw: unknown, labels?: Record<string, string | undefined>, context?: Record<string, unknown>): void
logWarn(message: string, labels?: Record<string, string | undefined>, context?: Record<string, unknown>): void
logInfo(message: string, labels?: Record<string, string | undefined>, context?: Record<string, unknown>): void
logDebug(message: string, labels?: Record<string, string | undefined>, context?: Record<string, unknown>): void
```

### Key behaviours
- `logError` auto-derives `errorType` from `error.name` — only pass explicitly to override (e.g. `{ errorType: 'DatabaseError' }`)
- `logError` accepts `unknown` — never cast with `as Error`
- `initRequestLogger` auto-seeds `userId` (from `request.auth.uid`) and `functionName` — do not pass these in labels
