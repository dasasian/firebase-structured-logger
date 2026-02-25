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
| `appId` | Application identifier (e.g. `neatpour`, `fernmath`) |
| `userId` | Firebase Auth UID |
| `screen` | Current screen name |
| `releaseId` | Git short hash or explicit release ID |
| `platform` | `ios`, `android`, `macos`, `windows`, `web` |
| `browser` | `chrome`, `firefox`, `safari`, `edge` |
| `errorType` | Error class name (e.g. `TypeError`, `NetworkError`) |
| `errorCategory` | `crash` for unhandled errors |
| `functionName` | Cloud Function name (server-side logs only) |

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

## Development (Local JSONL)

When running with Firebase Emulator, logs are written to the path configured in `initLogger({ devLogFile })`.

Set `DEV_LOG_FILE=/path/to/logs.jsonl` in the MCP server environment to enable local log reading.

Each JSONL line is a JSON object matching Cloud Logging structure for query compatibility.
