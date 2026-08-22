const DEFAULT_SESSION_LIMIT = 50
const DEFAULT_DUPLICATE_LIMIT = 3
const DEFAULT_STORAGE_KEY = 'fsl_ratelimit'

export interface RateLimitConfig {
  sessionLimit?: number
  duplicateLimit?: number
  storageKey?: string
}

interface RateLimitState {
  logCount: number
  errorSignatures: Record<string, number>
}

// Session-scoped by design: one browser session, one budget. Deliberately not
// per-Logger — see the module-scoped state rule in CLAUDE.md.
let config: Required<RateLimitConfig> = {
  sessionLimit: DEFAULT_SESSION_LIMIT,
  duplicateLimit: DEFAULT_DUPLICATE_LIMIT,
  storageKey: DEFAULT_STORAGE_KEY,
}

export function configureRateLimiter(options: RateLimitConfig): void {
  config = { ...config, ...options }
}

function readState(): RateLimitState {
  try {
    const stored = sessionStorage.getItem(config.storageKey)
    return stored ? JSON.parse(stored) : { logCount: 0, errorSignatures: {} }
  } catch {
    return { logCount: 0, errorSignatures: {} }
  }
}

function writeState(state: RateLimitState): void {
  try {
    sessionStorage.setItem(config.storageKey, JSON.stringify(state))
  } catch {
    // sessionStorage full or unavailable — rate limiting degrades, logging continues
  }
}

/**
 * Build the key used to recognise a repeat of the same problem. Two occurrences
 * count as duplicates only if the message, the screen and the activity all match,
 * so the same error from two different places is not collapsed into one.
 */
export function signatureFor(
  error: Error | string,
  screen?: string,
  activity?: string,
): string {
  const str = error instanceof Error ? `${error.name}:${error.message}` : String(error)
  return `${str}|${screen ?? ''}|${activity ?? ''}`
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: 'session-limit' | 'duplicate'; signature?: string }

/**
 * Decide whether one log may be sent, and consume its budget if so.
 *
 * Check and consume are one operation on purpose. They used to be separate
 * exports called from two different layers, which meant an error was checked
 * against the session limit twice and counted against it twice — a configured
 * limit of 50 was really 25 for errors. A single call cannot double-count, and
 * cannot be checked without consuming.
 *
 * Pass a `signature` to opt this log into duplicate suppression. Any severity
 * may do so; it is not reserved for errors.
 */
export function allow(signature?: string): RateLimitDecision {
  const state = readState()

  if (state.logCount >= config.sessionLimit) {
    return { allowed: false, reason: 'session-limit' }
  }

  if (signature !== undefined) {
    const seen = state.errorSignatures[signature] ?? 0
    if (seen >= config.duplicateLimit) {
      return { allowed: false, reason: 'duplicate', signature }
    }
    state.errorSignatures[signature] = seen + 1
  }

  state.logCount++
  writeState(state)
  return { allowed: true }
}

export function resetRateLimiter(): void {
  try {
    sessionStorage.removeItem(config.storageKey)
  } catch {
    // Silently fail
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', resetRateLimiter)
}
