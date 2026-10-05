# /query-logs — Cloud Logging Query Skill

Query structured logs written by firebase-structured-logger using the firebase-mcp-server.

## Setup

The `firebase_functions_logs` MCP tool reads from:
- **Production**: Google Cloud Logging (default)
- **Development**: Local JSONL file when `DEV_LOG_FILE` env var is set in the MCP server

## Missing or odd logs? Check the setup first

Before reading logs to explain why something is missing — no entries at all, stacks that
stay minified, no attachments — run the setup check. Most of those failures are silent
misconfigurations, and doctor reads them straight off disk:

```
npx fsl doctor --json
```

`findings` lists anything wrong, each with an `id`, `level` and `fix`; `setup` says how
logging, trace ids and Storage will behave. An empty `findings` means the setup is not
the problem, and the answer is in the logs.

## Queryable Labels

All entries written by firebase-structured-logger include these labels:

| Label | Description |
|-------|-------------|
| `appId` | Application identifier (e.g. `acme`, `store`) |
| `userId` | Firebase Auth UID |
| `screen` | Current screen name (falls back to `route` when the app never set one) |
| `route` | Route pattern, e.g. `/orders/:id/items` — group by this (apps using `enableNavigation`) |
| `path` | Real path, e.g. `/orders/1042/items` — one specific page or record; query string never stored |
| `routeSource` | `router` (the app named the route) or `pattern` (ids replaced by rule) |
| `trace` | On a slow-trace WARNING: the trace's name, e.g. `app_boot` |
| `run` | On a slow-trace WARNING: tells overlapping runs of one trace apart |
| `slow` | `trace` (the whole run passed its limit) or `step` (one step passed its own) |
| `step` | When `slow="step"`: the step that was late. `jsonPayload.timing` has every step's ms and what was still waiting |
| `releaseId` | Git short hash or explicit release ID |
| `platform` | `ios`, `android`, `macos`, `windows`, `web` |
| `browser` | `chrome`, `firefox`, `safari`, `edge` |
| `errorType` | Error class name (e.g. `TypeError`, `NetworkError`) |
| `errorCategory` | `crash` for unhandled errors |
| `functionName` | Cloud Function name (server-side logs only) |
| `logId` | ULID — unique per log entry, used to locate attachments in GCS |
| `hasAttachments` | `'true'` when attachments were uploaded alongside this entry |
| `repeatKey` | Client-side id carried by each full copy of an error that repeats |
| `repeatOf` | On a repeat summary: the `repeatKey` of the full copies it counts |
| `repeatCount` | On a repeat summary: how many further occurrences it stands for |
| `firstSeen`, `lastSeen` | On a repeat summary: the window those occurrences fell in |
| `sentLate` | `'true'` on a summary sent by a later visit than the one it counts |
| `truncated` | `'true'` when the entry was shortened to fit Cloud Logging's line limit |

App-specific labels are defined in each app's `AppLabels` type.

## Common Queries

### Everything one user did, in order
```
labels.userId="<uid>"
```
No severity filter. Frontend and backend entries share the `userId` label, so this
returns both halves interleaved in time order — the clicks and screen changes that
led up to a failure, the backend call that failed, and the error the browser saw.
Filtering to `severity=ERROR` keeps the crash and throws away the story; reach for
it only when you already know what you are looking for.

Add `labels.platform:*` for client entries only, or `labels.functionName:*` for
server entries only.

### Only the errors for a user
```
labels.userId="<uid>" severity=ERROR
```

### Errors on a specific screen
```
labels.screen="<screen>" severity=ERROR
```

### Unhandled crashes
```
labels.errorCategory="crash"
```

### Logs from a specific release
```
labels.releaseId="<hash>"
```

### Recent errors (last hour)
```
severity=ERROR timestamp>="<ISO8601>"
```

## How often did it really happen?

**Do not count entries.** A client sends an error in full only 3 times; after that it
counts the repeats and sends one `WARNING` summary per hour (and when the tab is hidden,
or on the user's next visit). Counting ERROR entries gives at most 3 per user, per
release, per hour — Cloud Error Reporting shows the same capped number.

The true count is the full copies plus the sum of `repeatCount`:

```
labels.repeatKey="<key>" OR labels.repeatOf="<key>"
```

Take `repeatKey` from any full copy. Every entry this returns is one occurrence, except
summaries: each summary is `labels.repeatCount` occurrences, between `labels.firstSeen`
and `labels.lastSeen`. A summary is timestamped at `lastSeen`, and `sentLate="true"`
means it arrived on a later visit — it still belongs at its own time.

A summary has no stack and no breadcrumbs. For those, read one of the full copies.

## Shortened entries

Cloud Functions and Cloud Run cut a log line at 102,400 bytes, so the library shortens
any entry over 90 KiB before writing it: breadcrumb data, then other context, then the
tail of the stack. Such an entry carries `labels.truncated="true"`, and when Storage is
configured `labels.hasAttachments="true"` — the whole original entry is saved as
`logAttachments/{logId}/fsl-overflow.json`. Read that file (see below) whenever the
context or breadcrumbs you need are missing from a truncated entry.

## Retrieving Attachments

When a log entry has `labels.hasAttachments = "true"`, files were uploaded to GCS alongside it.

**Step 1 — Find entries with attachments:**
```
labels.hasAttachments="true"
```

**Step 2 — List attachments for an entry:**

Use `firebase_storage_ls` with the path `logAttachments/{logId}/` to see what files are present.

**Step 3 — Download and analyze:**

Use `firebase_storage_read` with path `logAttachments/{logId}/{filename}` — this downloads the file to `/tmp` and returns a `tempPath`. Then use the `Read` tool on `tempPath` to analyze the content.

**Example flow:**
```
1. Query logs → find entry with logId "01KJBK2QBC5GJGMYZ5GT1Q5TQ6"
2. firebase_storage_ls  path: "logAttachments/01KJBK2QBC5GJGMYZ5GT1Q5TQ6/"
3. firebase_storage_read  path: "logAttachments/01KJBK2QBC5GJGMYZ5GT1Q5TQ6/photo.jpg"
4. Read tool on tempPath → analyze image in context of the error
```

Only check GCS when `hasAttachments = "true"` — entries without it have no files.

---

## Development (Local JSONL)

When running with Firebase Emulator, logs are written to the path configured in `initLogger({ devLogFile })`.

Set `DEV_LOG_FILE=/path/to/logs.jsonl` in the MCP server environment to enable local log reading.

Each JSONL line is a JSON object matching Cloud Logging structure for query compatibility.
