import type { LogPayload } from './shared/types'
import { setSendWatcher } from './client/logger'
import { resetBreadcrumbSession } from './client/breadcrumbs'
import { resetRateLimiter, clearPendingSummaries } from './client/rateLimiter'

export interface Capture {
  /** Pass this as `initLogger({ logFunction })`. */
  logFunction: (data: LogPayload) => Promise<void>
  /** Every entry `logFunction` received, in order. Find one with `entries.findLast(...)`. */
  entries: LogPayload[]
  /** Empties `entries`. */
  clear(): void
  /** Resolves once every send already started has reached `logFunction` or failed. */
  settled(): Promise<void>
}

const runningSends = new Set<Promise<unknown>>()

function trackSend(sending: Promise<unknown>): void {
  runningSends.add(sending)
  void sending.finally(() => runningSends.delete(sending))
}

/**
 * Each call gets its own `entries`. `settled()` is not per capture: the logger has one
 * watcher, so every capture's `settled()` waits for every send started since the
 * first `captureEntries()` call.
 */
export function captureEntries(): Capture {
  const entries: LogPayload[] = []
  setSendWatcher(trackSend)
  return {
    async logFunction(data) {
      entries.push(data)
    },
    entries,
    clear() {
      entries.length = 0
    },
    async settled() {
      await Promise.allSettled([...runningSends])
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
