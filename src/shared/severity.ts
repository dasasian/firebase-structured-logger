import type { LogSeverity } from './types'

/**
 * Single source of truth for severity ranking. Lower number = more severe.
 * Both the client and functions loggers filter against this, so a change here
 * keeps min-level behaviour consistent on both sides of the wire.
 */
export const SEVERITY_ORDER: Record<LogSeverity, number> = {
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
  DEBUG: 3,
}

export const SEVERITIES = Object.keys(SEVERITY_ORDER) as LogSeverity[]

/** Is this a severity the loggers know how to dispatch? */
export function isLogSeverity(value: unknown): value is LogSeverity {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, value)
}
