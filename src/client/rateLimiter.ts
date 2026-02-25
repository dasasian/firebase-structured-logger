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

let config: Required<RateLimitConfig> = {
  sessionLimit: DEFAULT_SESSION_LIMIT,
  duplicateLimit: DEFAULT_DUPLICATE_LIMIT,
  storageKey: DEFAULT_STORAGE_KEY,
}

export function configureRateLimiter(options: RateLimitConfig): void {
  config = { ...config, ...options }
}

function getState(): RateLimitState {
  try {
    const stored = sessionStorage.getItem(config.storageKey)
    return stored ? JSON.parse(stored) : { logCount: 0, errorSignatures: {} }
  } catch {
    return { logCount: 0, errorSignatures: {} }
  }
}

function saveState(state: RateLimitState): void {
  try {
    sessionStorage.setItem(config.storageKey, JSON.stringify(state))
  } catch {
    // Silently fail if sessionStorage is full
  }
}

function getErrorSignature(
  error: Error | string,
  screen: string | undefined,
  activity: string | undefined,
): string {
  const str = error instanceof Error ? `${error.name}:${error.message}` : String(error)
  return `${str}|${screen ?? ''}|${activity ?? ''}`
}

export function canLogEvent(): boolean {
  return getState().logCount < config.sessionLimit
}

export function canLogError(
  error: Error | string,
  screen?: string,
  activity?: string,
): boolean {
  const state = getState()
  if (state.logCount >= config.sessionLimit) {
    console.warn('[fsl] Session log limit reached')
    return false
  }
  const sig = getErrorSignature(error, screen, activity)
  if ((state.errorSignatures[sig] ?? 0) >= config.duplicateLimit) {
    console.warn(`[fsl] Duplicate error suppressed: ${sig}`)
    return false
  }
  return true
}

export function recordLog(): void {
  const state = getState()
  state.logCount++
  saveState(state)
}

export function recordError(
  error: Error | string,
  screen?: string,
  activity?: string,
): void {
  const state = getState()
  const sig = getErrorSignature(error, screen, activity)
  state.errorSignatures[sig] = (state.errorSignatures[sig] ?? 0) + 1
  state.logCount++
  saveState(state)
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
