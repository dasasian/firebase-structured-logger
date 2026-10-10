import * as fs from "fs";
import * as path from "path";
import { ulid } from "ulid";
import type { write as FirebaseWrite } from "firebase-functions/logger";
import type { LogSeverity, LogPayload, BreadcrumbEntry } from "../shared/types";
import { SEVERITY_ORDER, SEVERITIES, isLogSeverity, isFeedback } from "../shared/severity";
import { toError, toErrorPayload } from "../shared/error";
import { getAttachmentBucket, getAttachmentPrefix } from "./sourceMapCache";
import { attachmentPath } from "../shared/paths.js";
import { makeSelfIgnoringFolder } from "../shared/ignoredFolder.js";
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
const PROMOTED_LABELS_FIELD = "logging.googleapis.com/labels";
const TRACE_FIELD = "logging.googleapis.com/trace";
const MAX_SUMMARY_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_SUMMARY_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf-8");
const STACK_LINES_TO_KEEP_IN_TURN = [30, 15, 7, 3, 1];

function entryByteLength(entry: unknown): number {
  return Buffer.byteLength(safeStringify(entry), "utf-8");
}

/** Cut a string to `maxBytes` UTF-8 bytes, ending in "…" when it was cut. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes - ELLIPSIS_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ELLIPSIS;
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
  "timestamp",
  "message",
  PROMOTED_LABELS_FIELD,
  TRACE_FIELD,
  "stack_trace",
  "serviceContext",
  "error",
  "breadcrumbs",
  "timestamp",
]);

/** Keep only the last 10 breadcrumbs, each with its `data` field removed. */
function shrinkBreadcrumbs(breadcrumbs: BreadcrumbEntry[]): BreadcrumbEntry[] {
  return breadcrumbs.slice(-10).map(({ data: _data, ...rest }) => rest);
}

/** Cut `message`, `error.message` and `error.cause` to MAX_FIELD_BYTES each. */
function withTruncatedMessageFields(entry: Record<string, unknown>): Record<string, unknown> {
  const next = { ...entry };
  if (typeof next.message === "string") next.message = truncateToBytes(next.message, MAX_FIELD_BYTES);
  const error = next.error as Record<string, unknown> | undefined;
  if (error) {
    const nextError = { ...error };
    if (typeof nextError.message === "string") nextError.message = truncateToBytes(nextError.message, MAX_FIELD_BYTES);
    if (typeof nextError.cause === "string") nextError.cause = truncateToBytes(nextError.cause, MAX_FIELD_BYTES);
    next.error = nextError;
  }
  return next;
}

/** Cut any label value over MAX_LABEL_BYTES. */
function withTruncatedLabelValues(entry: Record<string, unknown>): Record<string, unknown> {
  const labels = entry[PROMOTED_LABELS_FIELD] as Record<string, string> | undefined;
  if (!labels) return entry;
  const nextLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    nextLabels[k] = Buffer.byteLength(v, "utf-8") > MAX_LABEL_BYTES ? truncateToBytes(v, MAX_LABEL_BYTES) : v;
  }
  return { ...entry, [PROMOTED_LABELS_FIELD]: nextLabels };
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

  if (Array.isArray(entry.breadcrumbs)) {
    entry = { ...entry, breadcrumbs: shrinkBreadcrumbs(entry.breadcrumbs as BreadcrumbEntry[]) };
    if (fits(entry)) return entry;
  }

  const extraKeys = Object.keys(entry).filter((k) => !PROTECTED_ENTRY_KEYS.has(k));
  if (extraKeys.length > 0) {
    const trimmed = { ...entry };
    for (const key of extraKeys) delete trimmed[key];
    entry = trimmed;
    if (fits(entry)) return entry;
  }

  const originalStackTrace = typeof entry.stack_trace === "string" ? entry.stack_trace : undefined;
  const originalError = entry.error as Record<string, unknown> | undefined;
  const originalErrorStack = typeof originalError?.stack === "string" ? originalError.stack : undefined;
  if (originalStackTrace !== undefined || originalErrorStack !== undefined) {
    for (const keepLines of STACK_LINES_TO_KEEP_IN_TURN) {
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

  entry = withTruncatedMessageFields(entry);
  if (fits(entry)) return entry;

  return withTruncatedLabelValues(entry);
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
          "Fix: name a bucket (createHttpLogHandler({ bucket }) or configureAttachments({ bucket })).",
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
    makeSelfIgnoringFolder(config.logLocalDir);
    rotateLogFile(config.logLocalDir, config.logMaxRotatedFiles ?? 5);
  }
}

function tolerateAnotherWorkerWinning(fileOperation: () => void): void {
  try {
    fileOperation();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Rotate the current log file to a timestamped backup, delete oldest files beyond limit.
 */
function rotateLogFile(logDir: string, maxRotatedFiles: number): void {
  const current = path.join(logDir, LOG_FILENAME);
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    tolerateAnotherWorkerWinning(() =>
      fs.renameSync(current, path.join(logDir, `dev-${timestamp}.jsonl`)),
    );

    const rotatedOldestFirst = fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith("dev-") && f.endsWith(".jsonl"))
      .sort();

    const toDelete = rotatedOldestFirst.slice(
      0,
      Math.max(0, rotatedOldestFirst.length - maxRotatedFiles),
    );
    for (const f of toDelete) {
      tolerateAnotherWorkerWinning(() => fs.unlinkSync(path.join(logDir, f)));
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

const FIREBASE_FUNCTIONS_CONSOLE_MAPPING: Record<
  LogSeverity,
  (message: string, ...args: unknown[]) => void
> = {
  ERROR: console.error,
  WARNING: console.warn,
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

function attachmentBucketOrNullWhenStorageThrows(): Bucket | null {
  try {
    return getAttachmentBucket();
  } catch (err) {
    console.warn("[fsl] Log attachment upload failed:", err);
    return null;
  }
}

interface CloudLoggingTimestamp {
  seconds: number;
  nanos: number;
}

function repeatSummaryTimestamp(
  labels: Record<string, unknown>,
  isoTimestamp: string | undefined,
): CloudLoggingTimestamp | undefined {
  if (labels.repeatCount === undefined || !isoTimestamp) return undefined;
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) return undefined;
  const now = Date.now();
  if (now - parsed > MAX_SUMMARY_AGE_MS || parsed - now > MAX_SUMMARY_CLOCK_SKEW_MS) return undefined;
  return { seconds: Math.floor(parsed / 1000), nanos: (parsed % 1000) * 1_000_000 };
}

function moveStackForErrorReporting(
  payload: LogPayload,
  severity: LogSeverity,
  labels: Record<string, string | undefined>,
): { reportingFields: Record<string, unknown>; jsonPayload: LogPayload["jsonPayload"] } {
  const stack = payload.jsonPayload?.error?.stack;
  const isReportable =
    stack && SEVERITY_ORDER[severity] <= SEVERITY_ORDER.ERROR && !isFeedback(payload.labels);
  const service = labels.appId ?? globalConfig?.appId;
  if (!isReportable || !service) return { reportingFields: {}, jsonPayload: payload.jsonPayload };

  const { error, ...rest } = payload.jsonPayload!;
  const { stack: _movedToStackTrace, ...errorWithoutStack } = error!;  return {
    reportingFields: {
      stack_trace: stack,
      serviceContext: {
        service,
        ...(labels.releaseId ? { version: labels.releaseId } : {}),
      },
    },
    jsonPayload: { ...rest, error: errorWithoutStack },
  };
}

function writeShrunkEntryAndSaveFull(finishedEntry: Record<string, unknown>, logId: string): void {
  const overflowBucket = attachmentBucketOrNullWhenStorageThrows();
  const overflowPath = attachmentPath(logId, OVERFLOW_ATTACHMENT_NAME, getAttachmentPrefix());

  const shrunkEntry = shrinkEntry(finishedEntry);
  const shrunkLabels = {
    ...(shrunkEntry[PROMOTED_LABELS_FIELD] as Record<string, string>),
    truncated: "true",
    ...(overflowBucket ? { hasAttachments: "true" } : {}),
  };

  writeEntry({
    ...shrunkEntry,
    [PROMOTED_LABELS_FIELD]: shrunkLabels,
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

/**
 * Write a structured log entry. Transport depends on environment.
 *
 * A severity outside the known set is written as ERROR, with one warning per bad
 * value, rather than dropped. Feedback (`labels.feedback`) is exempt from
 * `minSeverity`. In production the labels go under
 * `logging.googleapis.com/labels` and `jsonPayload` is spread to the top level; an
 * ERROR with a stack carries it at `stack_trace` for Error Reporting; a line over
 * 90 KiB is shrunk, with the full entry saved as an attachment.
 */
export function writeLog(
  payload: LogPayload & { functionName?: string; requestId?: string },
): void {
  const severity = isLogSeverity(payload.severity)
    ? payload.severity
    : coerceUnknownSeverity(payload.severity);

  const minSeverity =
    globalConfig?.minSeverity ?? (IS_EMULATOR ? "DEBUG" : "WARNING");
  const isFeedbackExemptFromFloor = isFeedback(payload.labels);
  if (
    !isFeedbackExemptFromFloor &&
    SEVERITY_ORDER[severity] > SEVERITY_ORDER[minSeverity]
  ) {
    return;
  }

  const logId = ulid();
  const hasAttachmentsToUpload = Boolean(
    payload.attachments && Object.keys(payload.attachments).length > 0,
  );
  const attachmentBucket = hasAttachmentsToUpload
    ? attachmentBucketOrNullWhenStorageThrows()
    : null;
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

    FIREBASE_FUNCTIONS_CONSOLE_MAPPING[severity](
      `[${severity}] ${payload.message}`,
      labels,
    );
    return;
  }

  const { reportingFields, jsonPayload } = moveStackForErrorReporting(payload, severity, labels);
  const fallbackTrace = traceField();
  const summaryTimestamp = repeatSummaryTimestamp(labels, payload.timestamp);

  const finishedEntry: Record<string, unknown> = {
    severity,
    message: payload.message,
    [PROMOTED_LABELS_FIELD]: labels,
    ...(fallbackTrace ? { [TRACE_FIELD]: fallbackTrace } : {}),
    ...reportingFields,
    ...jsonPayload,
    ...(summaryTimestamp ? { timestamp: summaryTimestamp } : {}),
  };

  if (entryByteLength(finishedEntry) <= MAX_ENTRY_BYTES) {
    writeEntry(finishedEntry as Parameters<EntryWriter>[0]);
    return;
  }

  writeShrunkEntryAndSaveFull(finishedEntry, logId);
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
