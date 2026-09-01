import * as fs from "fs";
import * as path from "path";
import { write as ffWrite } from "firebase-functions/logger";
import { ulid } from "ulid";
import type { LogSeverity, LogPayload } from "../shared/types";
import { SEVERITY_ORDER, SEVERITIES, isLogSeverity, isFeedback } from "../shared/severity";
import { toError, toErrorPayload } from "../shared/error";
import { getAttachmentBucket, getAttachmentPrefix } from "./sourceMapCache";
import { attachmentPath } from "../shared/paths.js";
import { traceResourceName } from "./traceContext";

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
  logId: string,
  logAttachments: Record<string, string>,
): Promise<void> {
  const bucket = getAttachmentBucket();
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
  // firebase-functions' own CONSOLE_SEVERITY inside ffWrite. A miss resolves to
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
  const hasAttachments =
    payload.attachments && Object.keys(payload.attachments).length > 0;
  const labels = {
    ...payload.labels,
    logId,
    ...(hasAttachments ? { hasAttachments: "true" } : {}),
  };

  if (hasAttachments) {
    uploadLogAttachments(logId, payload.attachments!).catch((err) => {
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

  // Production: use firebase-functions/logger write() directly, bypassing entryFromArgs.
  // This avoids server-side stack injection and jsonPayload nesting, while preserving
  // automatic trace context injection for request correlation in Cloud Logging.
  //
  // Labels MUST be emitted under "logging.googleapis.com/labels". ffWrite does no
  // mapping — it JSON-stringifies the object straight to stdout — and Cloud Logging
  // only promotes specifically-named fields to the LogEntry. A plain `labels` key is
  // not one of them, so it lands in jsonPayload.labels and `labels.appId="..."`
  // filters match nothing. Verified live: the smoke run's entry labels contained only
  // Cloud Functions' own platform labels until this changed.
  // Set the trace ourselves when we have one. ffWrite attaches this from
  // firebase-functions' own store, which is only populated inside their request
  // wrapper — empty on Cloud Run and anything behind createHttpLogHandler. When
  // theirs IS populated it overwrites this, which is the right precedence: inside
  // Cloud Functions their value is authoritative.
  const trace = traceResourceName();

  ffWrite({
    severity,
    message: payload.message,
    "logging.googleapis.com/labels": labels,
    ...(trace ? { "logging.googleapis.com/trace": trace } : {}),
    ...payload.jsonPayload,
  });
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
