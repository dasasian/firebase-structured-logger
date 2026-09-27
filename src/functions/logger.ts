import * as fs from "fs";
import * as path from "path";
import { ulid } from "ulid";
import type { write as FirebaseWrite } from "firebase-functions/logger";
import type { LogSeverity, LogPayload, BreadcrumbEntry } from "../shared/types";
import { SEVERITY_ORDER, SEVERITIES, isLogSeverity, isFeedback } from "../shared/severity";
import { toError, toErrorPayload } from "../shared/error";
import { getAttachmentBucket, getAttachmentPrefix } from "./sourceMapCache";
import { attachmentPath } from "../shared/paths.js";
import { traceField } from "./traceContext";
import type { Bucket } from "@google-cloud/storage";

type EntryWriter = typeof FirebaseWrite;

/**
 * OPTIONAL PEER — firebase-functions is loaded lazily, on purpose.
 *
 * On Cloud Functions it is always installed, and its `write()` is the only way to
 * attach the trace id of the current invocation: every v2 trigger (HTTP, callable,
 * Firestore, Pub/Sub, scheduler…) reads it from the incoming request and keeps it in
 * a store the package does not export. So where it exists, we use it.
 *
 * On Cloud Run, or any Node server behind `createHttpLogHandler`, it is not installed,
 * and a top-level import made this whole entry point fail on `require` there (#39).
 * Without it, `writeJsonLine` does the same job and traceContext supplies the trace.
 *
 * `require` rather than `await import`: `writeLog` is synchronous, and in this
 * CommonJS build a dynamic import compiles to `require` anyway.
 */
function loadFirebaseWrite(): EntryWriter | null {
  try {
    return (require("firebase-functions/logger") as { write: EntryWriter }).write;
  } catch {
    return null;
  }
}

let entryWriter: EntryWriter | undefined;

function writeEntry(entry: Parameters<EntryWriter>[0]): void {
  entryWriter ??= loadFirebaseWrite() ?? writeJsonLine;
  entryWriter(entry);
}

/**
 * JSON.stringify with a circular-safe replacer: a self-referencing object is
 * written as "[Circular]" rather than throwing. Shared by writeJsonLine and the
 * entry-size budget below — both have to measure/emit the exact same bytes.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v !== "object" || v === null) return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    return v;
  });
}

/**
 * What firebase-functions' `write()` does, minus the trace id: one JSON line, WARNING
 * and above to stderr and the rest to stdout (its console mapping), and a
 * self-referencing object written as "[Circular]" rather than throwing. Cloud Run's log
 * agent promotes `severity`, `message` and the `logging.googleapis.com/*` keys exactly
 * as Cloud Functions does.
 *
 * Writes to the streams, not `console`: firebase-functions' compat module patches
 * `console`, and a patched `console.error` would wrap this line a second time.
 */
export function writeJsonLine(entry: Parameters<EntryWriter>[0]): void {
  const line = safeStringify(entry);
  const toStderr =
    isLogSeverity(entry.severity) && SEVERITY_ORDER[entry.severity] <= SEVERITY_ORDER.WARNING;
  (toStderr ? process.stderr : process.stdout).write(line + "\n");
}

/**
 * Cloud Functions and Cloud Run both cut a stdout/stderr log line at exactly
 * 102,400 bytes (100 KiB) — past that, the platform delivers it as broken
 * plain text with no severity or labels, and Error Reporting never sees it
 * (issue #21). The margin below that ceiling covers firebase-functions adding
 * its own trace field after this measurement, plus multi-byte UTF-8
 * characters, which count for more bytes than JS string length.
 */
const MAX_ENTRY_BYTES = 90 * 1024;
const MAX_FIELD_BYTES = 8 * 1024;
const MAX_LABEL_BYTES = 1024;
const OVERFLOW_ATTACHMENT_NAME = "fsl-overflow.json";
const STACK_TRUNCATION_MARKER = "    … truncated by fsl";

function entryByteLength(entry: unknown): number {
  return Buffer.byteLength(safeStringify(entry), "utf-8");
}

/** Cut a string to `maxBytes` UTF-8 bytes, ending in "…" when it was cut. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  // Binary search the largest prefix (in UTF-16 code units) whose UTF-8
  // encoding still fits, leaving room for the ellipsis.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes - 3) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** Keep the first `keepLines` lines of a stack, noting that it was cut. */
function truncateStackLines(stack: string, keepLines: number): string {
  const lines = stack.split("\n");
  if (lines.length <= keepLines) return stack;
  return [...lines.slice(0, keepLines), STACK_TRUNCATION_MARKER].join("\n");
}

// Top-level keys writeLog itself puts on the entry, or that it spreads
// straight from jsonPayload.error/breadcrumbs. Anything else spread from
// jsonPayload (context, or a future field) is an "other payload key" for
// shrink step (b). severity, the two logging.googleapis.com/* keys and
// serviceContext are never removed by any step.
const PROTECTED_ENTRY_KEYS = new Set([
  "severity",
  "message",
  "logging.googleapis.com/labels",
  "logging.googleapis.com/trace",
  "stack_trace",
  "serviceContext",
  "error",
  "breadcrumbs",
]);

/** Keep only the last 10 breadcrumbs, each with its `data` field removed. */
function shrinkBreadcrumbs(breadcrumbs: BreadcrumbEntry[]): BreadcrumbEntry[] {
  return breadcrumbs.slice(-10).map(({ data: _data, ...rest }) => rest);
}

/**
 * Shrink a too-large entry, re-measuring after each step and stopping as soon
 * as it fits under MAX_ENTRY_BYTES. Order runs from least to most useful:
 * breadcrumb `data` first, then whole non-error payload keys, then the tail of
 * a stack (Error Reporting groups on the top frames, so those are kept
 * longest), then long text fields, and label values only as a last resort.
 *
 * Builds new objects at every step — the caller's original entry (and the
 * copy saved as the overflow attachment) must not be mutated.
 */
function shrinkEntry(original: Record<string, unknown>): Record<string, unknown> {
  const fits = (entry: Record<string, unknown>) => entryByteLength(entry) <= MAX_ENTRY_BYTES;

  let entry = original;
  if (fits(entry)) return entry;

  // a. breadcrumbs -> last 10, without `data`.
  if (Array.isArray(entry.breadcrumbs)) {
    entry = { ...entry, breadcrumbs: shrinkBreadcrumbs(entry.breadcrumbs as BreadcrumbEntry[]) };
    if (fits(entry)) return entry;
  }

  // b. every other jsonPayload key (context, and anything else a caller adds).
  const extraKeys = Object.keys(entry).filter((k) => !PROTECTED_ENTRY_KEYS.has(k));
  if (extraKeys.length > 0) {
    const trimmed = { ...entry };
    for (const key of extraKeys) delete trimmed[key];
    entry = trimmed;
    if (fits(entry)) return entry;
  }

  // c. stack_trace and error.stack -> the top frames matter most, so cut
  // harder in steps rather than all the way in one go.
  const originalStackTrace = typeof entry.stack_trace === "string" ? entry.stack_trace : undefined;
  const originalError = entry.error as Record<string, unknown> | undefined;
  const originalErrorStack = typeof originalError?.stack === "string" ? originalError.stack : undefined;
  if (originalStackTrace !== undefined || originalErrorStack !== undefined) {
    for (const keepLines of [30, 15, 7, 3, 1]) {
      const next = { ...entry };
      if (originalStackTrace !== undefined) {
        next.stack_trace = truncateStackLines(originalStackTrace, keepLines);
      }
      if (originalErrorStack !== undefined) {
        next.error = { ...originalError, stack: truncateStackLines(originalErrorStack, keepLines) };
      }
      entry = next;
      if (fits(entry)) return entry;
    }
  }

  // d. message, error.message and error.cause -> 8 KiB each.
  {
    const next = { ...entry };
    if (typeof next.message === "string") next.message = truncateToBytes(next.message, MAX_FIELD_BYTES);
    const error = next.error as Record<string, unknown> | undefined;
    if (error) {
      const nextError = { ...error };
      if (typeof nextError.message === "string") nextError.message = truncateToBytes(nextError.message, MAX_FIELD_BYTES);
      if (typeof nextError.cause === "string") nextError.cause = truncateToBytes(nextError.cause, MAX_FIELD_BYTES);
      next.error = nextError;
    }
    entry = next;
    if (fits(entry)) return entry;
  }

  // e. last resort: any label value over 1 KiB.
  const labels = entry["logging.googleapis.com/labels"] as Record<string, string> | undefined;
  if (labels) {
    const nextLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      nextLabels[k] = Buffer.byteLength(v, "utf-8") > MAX_LABEL_BYTES ? truncateToBytes(v, MAX_LABEL_BYTES) : v;
    }
    entry = { ...entry, "logging.googleapis.com/labels": nextLabels };
  }

  return entry;
}

// Warned once per process, not per entry — an app producing one oversized
// entry usually produces many, and the cause is the same every time.
let warnedOverBudget = false;
function warnOverBudget(objectPath: string | undefined): void {
  if (warnedOverBudget) return;
  warnedOverBudget = true;
  console.warn(
    `[fsl] A log entry was over ${MAX_ENTRY_BYTES} bytes. Cloud Functions and Cloud Run cut a ` +
      "line at 102,400 bytes and it would have arrived broken, so it was shortened before writing.",
  );
  console.warn(
    objectPath
      ? `[fsl]   The full entry was saved to ${objectPath}.`
      : "[fsl]   It was lost: there is no Storage to save the full entry to. " +
          "Fix: name a bucket (createHttpLogHandler({ bucketName }) or configureAttachments({ bucket })).",
  );
}

const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";
export const LOG_FILENAME = "dev.jsonl";

interface FunctionsLoggerConfig {
  appId: string;
  logLocalDir?: string;
  logMaxRecordsPerFile?: number; // default 2000
  logMaxRotatedFiles?: number; // default 5
  minSeverity?: LogSeverity; // default 'WARNING' in production, 'DEBUG' in emulator
}

let globalConfig: FunctionsLoggerConfig | null = null;
let currentRecordCount = 0;

/**
 * Initialize the functions-side logger.
 * Call once at module load (before any onCall handlers run).
 */
export function initLogger(config: FunctionsLoggerConfig): void {
  globalConfig = config;
  currentRecordCount = 0;

  if (IS_EMULATOR && config.logLocalDir) {
    fs.mkdirSync(config.logLocalDir, { recursive: true });
    rotateLogFile(config.logLocalDir, config.logMaxRotatedFiles ?? 5);
  }
}

/**
 * Rotate the current log file to a timestamped backup, delete oldest files beyond limit.
 */
function rotateLogFile(logDir: string, maxRotatedFiles: number): void {
  const current = path.join(logDir, LOG_FILENAME);
  try {
    // The functions emulator spawns multiple worker processes that each call
    // initLogger() on startup. existsSync + renameSync is a TOCTOU race:
    // a parallel worker can rename the file between our check and our rename.
    // Attempt the rename and swallow ENOENT — it means another worker already rotated.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.renameSync(current, path.join(logDir, `dev-${timestamp}.jsonl`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Another worker rotated first (or no previous log file to rotate) — fine
    }

    // Delete oldest rotated files beyond limit
    const rotated = fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith("dev-") && f.endsWith(".jsonl"))
      .sort(); // ISO timestamps sort lexicographically = chronologically

    const toDelete = rotated.slice(
      0,
      Math.max(0, rotated.length - maxRotatedFiles),
    );
    for (const f of toDelete) {
      try {
        fs.unlinkSync(path.join(logDir, f));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // Another worker already deleted it — fine
      }
    }
  } catch (err) {
    console.warn("[fsl] Failed to rotate log file:", err);
  }
}

async function uploadLogAttachments(
  bucket: Bucket,
  logId: string,
  logAttachments: Record<string, string>,
): Promise<void> {
  await Promise.all(
    Object.entries(logAttachments).map(async ([name, data]) => {
      const file = bucket.file(attachmentPath(logId, name, getAttachmentPrefix()));
      await file.save(Buffer.from(data, "base64"));
    }),
  );
}

// Warn once per bad value: writeLog is on the per-log path, and a caller with a
// broken severity will hit it every time.
const warnedSeverities = new Set<string>();
function coerceUnknownSeverity(value: unknown): LogSeverity {
  const shown = typeof value === "string" ? value : String(value);
  if (!warnedSeverities.has(shown)) {
    warnedSeverities.add(shown);
    console.warn(
      `[fsl] Unknown severity ${JSON.stringify(shown)} — writing as ERROR. ` +
        `Valid values: ${SEVERITIES.join(", ")}.`,
    );
  }
  return "ERROR";
}

const CONSOLE_FN: Record<
  LogSeverity,
  (message: string, ...args: unknown[]) => void
> = {
  ERROR: console.error,
  WARNING: console.warn,
  // There is no console.notice. firebase-functions maps NOTICE to console.info
  // on the production side, so match that rather than inventing a mapping.
  NOTICE: console.info,
  DEBUG: console.debug,
  INFO: console.log,
};

/**
 * Strip null/undefined labels and convert all values to strings for Cloud Logging.
 */
export function cleanLabels(
  labels: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!labels) return {};
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = String(value);
    }
  }
  return cleaned;
}

/**
 * Write a structured log entry. Transport depends on environment.
 */
export function writeLog(
  payload: LogPayload & { functionName?: string; requestId?: string },
): void {
  // An unrecognised severity is not merely mislabelled — it is fatal. Both
  // dispatches look the value up in a fixed table: CONSOLE_FN below, and
  // firebase-functions' own CONSOLE_SEVERITY inside its write(). A miss resolves to
  // undefined and calling it throws, which Logger.send()'s catch then swallows,
  // so the entry disappears with no useful diagnostic — and only in production,
  // since the emulator takes the other branch.
  //
  // It also slips past the floor: SEVERITY_ORDER[unknown] is undefined, and
  // `undefined > n` is false, so the check below would not have stopped it.
  //
  // writeLog is exported, so a caller can reach this with a value read from
  // config, crossing a type boundary, or from plain JavaScript. Coerce to ERROR
  // rather than drop: an entry arriving loud beats one vanishing quietly.
  const severity = isLogSeverity(payload.severity)
    ? payload.severity
    : coerceUnknownSeverity(payload.severity);

  // Feedback bypasses the floor. The client already bypassed its own, but the
  // payload still passes through here on its way to Cloud Logging, and this
  // floor defaults to WARNING in production — so without the exemption every
  // report would be dropped here instead. Verified: it was.
  const minSeverity =
    globalConfig?.minSeverity ?? (IS_EMULATOR ? "DEBUG" : "WARNING");
  if (
    !isFeedback(payload.labels) &&
    SEVERITY_ORDER[severity] > SEVERITY_ORDER[minSeverity]
  ) {
    return;
  }

  const logId = ulid();
  // Resolved before the labels, so `hasAttachments` is only claimed when there is
  // somewhere to put them. With no Storage the attachments are dropped (warned once
  // by getAttachmentBucket) and the entry is still written.
  let attachmentBucket: Bucket | null = null;
  if (payload.attachments && Object.keys(payload.attachments).length > 0) {
    try {
      attachmentBucket = getAttachmentBucket();
    } catch (err) {
      console.warn("[fsl] Log attachment upload failed:", err);
    }
  }
  const hasAttachments = attachmentBucket !== null;
  const labels = {
    ...payload.labels,
    logId,
    ...(hasAttachments ? { hasAttachments: "true" } : {}),
  };

  if (attachmentBucket) {
    uploadLogAttachments(attachmentBucket, logId, payload.attachments!).catch((err) => {
      console.warn("[fsl] Log attachment upload failed:", err);
    });
  }

  if (IS_EMULATOR) {
    if (globalConfig?.logLocalDir) {
      try {
        const entry = {
          timestamp: new Date().toISOString(),
          severity,
          message: payload.message,
          labels,
          jsonPayload: payload.jsonPayload,
          ...(payload.functionName
            ? { functionName: payload.functionName }
            : {}),
          ...(payload.requestId ? { requestId: payload.requestId } : {}),
        };
        const maxRecords = globalConfig.logMaxRecordsPerFile ?? 2000;
        const maxRotated = globalConfig.logMaxRotatedFiles ?? 5;
        if (currentRecordCount >= maxRecords) {
          rotateLogFile(globalConfig.logLocalDir, maxRotated);
          currentRecordCount = 0;
        }
        const logFile = path.join(globalConfig.logLocalDir, LOG_FILENAME);
        fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
        currentRecordCount++;
      } catch (err) {
        console.warn("[fsl] Failed to write to log file:", err);
      }
    }

    // Also write to console for immediate visibility
    CONSOLE_FN[severity](
      `[${severity}] ${payload.message}`,
      labels,
    );
    return;
  }

  // Production: firebase-functions' write() where it is installed, writeJsonLine
  // where it is not (see loadFirebaseWrite) — bypassing entryFromArgs. This avoids server-side stack injection and
  // jsonPayload nesting, while preserving automatic trace context injection for
  // request correlation in Cloud Logging.
  //
  // Labels MUST be emitted under "logging.googleapis.com/labels". write() does no
  // mapping — it JSON-stringifies the object straight to stdout — and Cloud Logging
  // only promotes specifically-named fields to the LogEntry. A plain `labels` key is
  // not one of them, so it lands in jsonPayload.labels and `labels.appId="..."`
  // filters match nothing. Verified live: the smoke run's entry labels contained only
  // Cloud Functions' own platform labels until this changed.
  // Cloud Error Reporting reads Cloud Logging and groups by exception type plus
  // the five top-most frames — the fingerprint we would otherwise build. It
  // looks for `stack_trace` at the TOP level of jsonPayload; ours lives one
  // level down under `error`, so it has never been seen (#31).
  //
  // Moved, not duplicated. The stack is the largest field in an entry capped at
  // 256 KB, and two copies of it buys nothing — so a reportable error carries its
  // stack at `stack_trace` and its `error` object loses the `stack` key.
  //
  // A non-reportable entry keeps the stack where it was. It has to go somewhere,
  // and the alternative — emitting `stack_trace` for warnings too — would likely
  // turn every warning into something a person has to resolve in the Error
  // Reporting console. The smoke run measures whether that is true; until it
  // does, the cautious shape is the one that ships.
  //
  // ERROR and above only. A WARNING carrying a stack is not an error someone
  // should have to resolve, and neither is a NOTICE feedback report — turning
  // either into an Error Reporting group would be a regression of a deliberate
  // product decision.
  const stack = payload.jsonPayload?.error?.stack;
  const reportable =
    stack && SEVERITY_ORDER[severity] <= SEVERITY_ORDER.ERROR && !isFeedback(payload.labels);
  const service = labels.appId ?? globalConfig?.appId;
  const isReported = Boolean(reportable && service);
  const errorReporting = isReported
    ? {
        stack_trace: stack,
        serviceContext: {
          service: service!,
          ...(labels.releaseId ? { version: labels.releaseId } : {}),
        },
      }
    : {};

  // Strip the now-redundant copy. Rebuilt rather than mutated: payload is the
  // caller's object and writeLog has no business editing it.
  const jsonPayload = isReported
    ? (() => {
        const { error, ...rest } = payload.jsonPayload!;
        const { stack: _dropped, ...errorWithoutStack } = error!;
        return { ...rest, error: errorWithoutStack };
      })()
    : payload.jsonPayload;

  // Set the trace ourselves when we have one. write() attaches this from
  // firebase-functions' own store, which is only populated inside their request
  // wrapper — empty on Cloud Run and anything behind createHttpLogHandler. When
  // theirs IS populated it overwrites this, which is the right precedence: inside
  // Cloud Functions their value is authoritative.
  const trace = traceField();

  const finishedEntry: Record<string, unknown> = {
    severity,
    message: payload.message,
    "logging.googleapis.com/labels": labels,
    ...(trace ? { "logging.googleapis.com/trace": trace } : {}),
    ...errorReporting,
    ...jsonPayload,
  };

  if (entryByteLength(finishedEntry) <= MAX_ENTRY_BYTES) {
    writeEntry(finishedEntry as Parameters<EntryWriter>[0]);
    return;
  }

  // Over budget. Resolve a bucket for the overflow attachment the same way
  // attachments do: firebase-admin can throw synchronously with no
  // initialised app, and that is "no Storage", not a crash.
  let overflowBucket: Bucket | null = null;
  try {
    overflowBucket = getAttachmentBucket();
  } catch (err) {
    console.warn("[fsl] Log attachment upload failed:", err);
  }
  const overflowPath = attachmentPath(logId, OVERFLOW_ATTACHMENT_NAME, getAttachmentPrefix());

  const shrunkEntry = shrinkEntry(finishedEntry);
  const shrunkLabels = {
    ...(shrunkEntry["logging.googleapis.com/labels"] as Record<string, string>),
    truncated: "true",
    ...(overflowBucket ? { hasAttachments: "true" } : {}),
  };

  writeEntry({
    ...shrunkEntry,
    "logging.googleapis.com/labels": shrunkLabels,
  } as unknown as Parameters<EntryWriter>[0]);

  if (overflowBucket) {
    overflowBucket
      .file(overflowPath)
      .save(Buffer.from(safeStringify(finishedEntry), "utf-8"))
      .catch((err) => {
        console.warn(`[fsl] Overflow upload failed for ${overflowPath}:`, err);
      });
  }

  warnOverBudget(overflowBucket ? overflowPath : undefined);
}

function logAttachmentsToBase64(
  logAttachments: Record<string, string | Buffer> | undefined,
): Record<string, string> | undefined {
  if (!logAttachments) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(logAttachments)) {
    result[k] = v instanceof Buffer ? v.toString("base64") : (v as string);
  }
  return result;
}

/**
 * Convenience wrapper that builds a logger object for a given label set.
 */
export function createLogWriter(
  baseLabels: Record<string, string | undefined>,
) {
  const merge = (extra?: Record<string, string | undefined>) =>
    ({ ...baseLabels, ...extra }) as LogPayload["labels"];

  const write = (
    severity: LogSeverity,
    message: string,
    labels?: Record<string, string | undefined>,
    context?: Record<string, unknown>,
    attachments?: Record<string, string | Buffer>,
  ): void => {
    writeLog({
      message,
      severity,
      labels: merge(labels),
      jsonPayload: { context },
      attachments: logAttachmentsToBase64(attachments),
    });
  };

  return {
    error(
      raw: unknown,
      labels?: Record<string, string | undefined>,
      context?: Record<string, unknown>,
      attachments?: Record<string, string | Buffer>,
    ): void {
      const error = toError(raw);
      writeLog({
        message: error.message,
        severity: "ERROR",
        labels: merge({ errorType: error.name, ...labels }),
        jsonPayload: { context, error: toErrorPayload(error) },
        attachments: logAttachmentsToBase64(attachments),
      });
    },
    info: (
      message: string,
      labels?: Record<string, string | undefined>,
      context?: Record<string, unknown>,
      attachments?: Record<string, string | Buffer>,
    ): void => write("INFO", message, labels, context, attachments),
    warning: (
      message: string,
      labels?: Record<string, string | undefined>,
      context?: Record<string, unknown>,
      attachments?: Record<string, string | Buffer>,
    ): void => write("WARNING", message, labels, context, attachments),
    debug: (
      message: string,
      labels?: Record<string, string | undefined>,
      context?: Record<string, unknown>,
      attachments?: Record<string, string | Buffer>,
    ): void => write("DEBUG", message, labels, context, attachments),
  };
}

export type LogWriter = ReturnType<typeof createLogWriter>;

// Re-export severity type for consumers
export type { LogSeverity };
