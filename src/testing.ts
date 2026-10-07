import type { LogPayload } from './shared/types'
import { resetBreadcrumbSession } from './client/breadcrumbs'
import { resetRateLimiter, clearPendingSummaries } from './client/rateLimiter'

/**
 * `@dasasian/firebase-structured-logger/testing` — its own entry point (CLAUDE.md,
 * "`/testing` is for apps' tests"), so an app ships none of it. Only test files
 * import this module, and nothing in it needs a DOM: it reads and resets module
 * state the core already holds, through the same functions the core's own test
 * suites use.
 */
export interface Capture {
  /** Pass this as `initLogger({ logFunction })`. */
  logFunction: (data: LogPayload) => Promise<void>
  /** Exactly what `logFunction` received, in order — after cleaning, size limits
   *  and the rate limiter. Find your entry with `entries.findLast(...)`, never by
   *  position: an entry the rate limiter dropped is simply absent. */
  entries: LogPayload[]
  /** Empties `entries`. Does not touch the session — see `resetSession()`. */
  clear(): void
}

/**
 * Each call returns its own `entries` array in its own closure, so two captures
 * — in the same test file, or across `configureTwice`'s "called twice" check —
 * never share state.
 */
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
 * Starts a fresh session, as a new browser tab would: an empty breadcrumb trail,
 * no current page, a full rate-limit budget, no duplicate counts and no pending
 * repeat summaries. Call it before each test — see README, "Testing what your
 * app logs" for why both the trail and the budget otherwise carry over.
 *
 * Deliberately leaves configuration alone, as opposed to session state: whether
 * `enableNavigation()`/a router adapter is wired, and `enableViews()`'s reader,
 * are facts about how the app is set up, not about the session in progress, and
 * a real new tab would not lose them either.
 */
export function resetSession(): void {
  resetBreadcrumbSession()
  resetRateLimiter()
  clearPendingSummaries()
}
