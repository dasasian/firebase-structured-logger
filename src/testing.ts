import type { LogPayload } from './shared/types'
import { resetBreadcrumbSession } from './client/breadcrumbs'
import { resetRateLimiter, clearPendingSummaries } from './client/rateLimiter'

export interface Capture {
  /** Pass this as `initLogger({ logFunction })`. */
  logFunction: (data: LogPayload) => Promise<void>
  /** Every entry `logFunction` received, in order. Find one with `entries.findLast(...)`. */
  entries: LogPayload[]
  /** Empties `entries`. */
  clear(): void
}

/** Each call is independent. */
export function captureEntries(): Capture {
  const entries: LogPayload[] = []
  return {
    async logFunction(data) {
      entries.push(data)
    },
    entries,
    clear() {
      entries.length = 0
    },
  }
}

/**
 * Clears the breadcrumb trail, the current page, the rate-limit budget, duplicate
 * counts and pending repeat summaries. Leaves configuration — `enableNavigation()`/a
 * router adapter, `enableViews()`'s reader — in place.
 */
export function resetSession(): void {
  resetBreadcrumbSession()
  resetRateLimiter()
  clearPendingSummaries()
}
