import type { LogSeverity } from './types'

/**
 * Single source of truth for severity ranking. Lower number = more severe.
 *
 * NOTICE ranks between WARNING and INFO, matching Cloud Logging's own ordering
 * (INFO 200, NOTICE 300, WARNING 400). Its official meaning — "normal but
 * significant events" — is where user feedback belongs: more important than
 * routine status, not a warning about system health.
 * Both the client and functions loggers filter against this, so a change here
 * keeps min-level behaviour consistent on both sides of the wire.
 */
export const SEVERITY_ORDER: Record<LogSeverity, number> = {
  ERROR: 0,
  WARNING: 1,
  NOTICE: 2,
  INFO: 3,
  DEBUG: 4,
}

export const SEVERITIES = Object.keys(SEVERITY_ORDER) as LogSeverity[]

/** Is this a severity the loggers know how to dispatch? */
export function isLogSeverity(value: unknown): value is LogSeverity {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, value)
}

/**
 * Label marking an entry as user feedback rather than a system event.
 *
 * The severity floors are volume and cost controls for events the system emits.
 * Feedback is a person sending a message that happens to travel the same pipe,
 * so it is exempt from them — on BOTH sides, since the client and the functions
 * logger each have their own floor and either one would drop it silently.
 *
 * The exemption keys on this marker, not on the NOTICE severity. A NOTICE
 * emitted for anything else still respects the floor, otherwise we would have
 * built a severity level that silently defeats filtering.
 */
export const FEEDBACK_LABEL = 'feedback'

export function isFeedback(labels: Record<string, unknown> | undefined): boolean {
  return labels?.[FEEDBACK_LABEL] === 'true'
}
