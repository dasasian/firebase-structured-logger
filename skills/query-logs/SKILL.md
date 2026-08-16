# /query-logs — Cloud Logging Query Skill

Query structured logs written by firebase-structured-logger using the firebase-mcp-server.

## Setup

The `firebase_functions_logs` MCP tool reads from:
- **Production**: Google Cloud Logging (default)
- **Development**: Local JSONL file when `DEV_LOG_FILE` env var is set in the MCP server

## Queryable Labels

All entries written by firebase-structured-logger include these labels:

| Label | Description |
|-------|-------------|
| `appId` | Application identifier (e.g. `acme`, `store`) |
| `userId` | Firebase Auth UID |
| `screen` | Current screen name |
| `releaseId` | Git short hash or explicit release ID |
| `platform` | `ios`, `android`, `macos`, `windows`, `web` |
| `browser` | `chrome`, `firefox`, `safari`, `edge` |
| `errorType` | Error class name (e.g. `TypeError`, `NetworkError`) |
| `errorCategory` | `crash` for unhandled errors |
| `functionName` | Cloud Function name (server-side logs only) |
| `logId` | ULID — unique per log entry, used to locate attachments in GCS |
| `hasAttachments` | `'true'` when attachments were uploaded alongside this entry |

App-specific labels are defined in each app's `AppLabels` type.

## Common Queries

### All errors for a user
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
