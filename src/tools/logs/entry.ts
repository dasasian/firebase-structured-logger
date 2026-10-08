import * as fs from 'fs'
import * as path from 'path'

/** One log entry in the shape `fsl logs` prints, whether it came from Cloud Logging or a local file. */
export interface LogEntry {
  timestamp: string
  severity: string
  message?: string
  labels: Record<string, string>
  functionName?: string
  requestId?: string
  trace?: string
  insertId?: string
  jsonPayload?: Record<string, unknown>
}

export interface CloudLoggingEntry {
  timestamp?: string
  receiveTimestamp?: string
  severity?: string
  textPayload?: string
  jsonPayload?: Record<string, unknown>
  labels?: Record<string, string>
  resource?: { labels?: Record<string, string> }
  trace?: string
  insertId?: string
}

export interface LocalEntry {
  timestamp?: string
  severity?: string
  message?: string
  labels?: Record<string, string>
  jsonPayload?: Record<string, unknown>
  functionName?: string
  requestId?: string
}

export const LOCAL_LOG_DIR = '.fsl-logs'

function withoutKeys(payload: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
  if (!payload) return undefined
  const kept = Object.fromEntries(Object.entries(payload).filter(([key]) => !keys.includes(key)))
  return Object.keys(kept).length > 0 ? kept : undefined
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function messageOf(textPayload: string | undefined, jsonPayload: Record<string, unknown> | undefined): string | undefined {
  if (textPayload !== undefined) return textPayload
  return typeof jsonPayload?.message === 'string' ? jsonPayload.message : undefined
}

/**
 * Maps one `gcloud logging read --format json` element (a Cloud Logging `LogEntry`) to
 * the shared shape. fsl writes labels under `logging.googleapis.com/labels`, which
 * Cloud Logging promotes to `labels`; a Cloud Run v2 entry may still carry them under
 * `jsonPayload.labels`, so both are read.
 */
export function normalizeCloudEntry(raw: CloudLoggingEntry): LogEntry {
  const payloadLabels = raw.jsonPayload?.labels as Record<string, string> | undefined
  const resourceLabels = raw.resource?.labels
  return definedOnly({
    timestamp: raw.timestamp ?? raw.receiveTimestamp ?? '',
    severity: raw.severity ?? 'DEFAULT',
    message: messageOf(raw.textPayload, raw.jsonPayload),
    labels: { ...payloadLabels, ...raw.labels },
    functionName: resourceLabels?.function_name ?? resourceLabels?.service_name,
    trace: raw.trace,
    insertId: raw.insertId,
    jsonPayload: withoutKeys(raw.jsonPayload, ['message', 'labels']),
  })
}

/** Maps one line of `.fsl-logs/dev.jsonl`, as the functions logger's emulator branch writes it, to the shared shape. */
export function normalizeLocalEntry(raw: LocalEntry): LogEntry {
  return definedOnly({
    timestamp: raw.timestamp ?? '',
    severity: raw.severity ?? 'DEFAULT',
    message: raw.message ?? messageOf(undefined, raw.jsonPayload),
    labels: raw.labels ?? {},
    functionName: raw.functionName,
    requestId: raw.requestId,
    jsonPayload: withoutKeys(raw.jsonPayload, ['message', 'labels']),
  })
}

export interface LocalRead {
  entries: LogEntry[]
  unreadableLines: number
}

function localLogFiles(logDir: string): string[] {
  const names = fs.readdirSync(logDir).filter((name) => name === 'dev.jsonl' || (name.startsWith('dev-') && name.endsWith('.jsonl')))
  return names.sort().map((name) => path.join(logDir, name))
}

/** Reads the current and rotated `dev*.jsonl` files in `logDir`; a line that is not JSON is counted, not fatal. */
export function readLocalEntries(logDir: string): LocalRead {
  const entries: LogEntry[] = []
  let unreadableLines = 0
  for (const file of localLogFiles(logDir)) {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(normalizeLocalEntry(JSON.parse(line) as LocalEntry))
      } catch {
        unreadableLines++
      }
    }
  }
  return { entries, unreadableLines }
}
