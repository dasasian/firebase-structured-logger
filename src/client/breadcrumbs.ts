import type { BreadcrumbEntry } from '../shared/types'

/**
 * How many breadcrumbs are retained — and therefore how many are sent.
 *
 * These were two numbers once: the trail kept 50 and the send path asked for
 * 20, so 30 were retained that nothing could ever read. Exported for the send
 * path to import rather than restate, because the two drifting apart is silent
 * — the extra entries simply never appear in any log, and nothing fails.
 *
 * MAX_AGE_MS is the filter that actually matters; this is the safety net that
 * bounds a long-lived tab. Sending the whole retained trail costs ~5 KB, which
 * is 2% of Cloud Logging's 256 KB entry limit, against losing the steps that
 * would have reproduced the bug.
 */
export const MAX_BREADCRUMBS = 50
const MAX_AGE_MS = 5 * 60 * 1000 // 5 minutes

let currentScreen: string | undefined
let breadcrumbs: BreadcrumbEntry[] = []

export function setCurrentScreen(screen: string): void {
  currentScreen = screen
  addBreadcrumb('nav', `navigate_${screen}`)
}

export function getCurrentScreen(): string | undefined {
  return currentScreen
}

export function addBreadcrumb(
  type: BreadcrumbEntry['type'],
  name: string,
  data?: Record<string, unknown>,
): void {
  const now = Date.now()
  const entry: BreadcrumbEntry = { timestamp: now, type, name, data }
  breadcrumbs.push(entry)

  // Entries are appended in timestamp order, so only rebuild the array when the
  // oldest one has actually aged out — otherwise there is nothing to drop.
  const cutoff = now - MAX_AGE_MS
  if (breadcrumbs[0].timestamp <= cutoff) {
    breadcrumbs = breadcrumbs.filter((bc) => bc.timestamp > cutoff)
  }

  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs = breadcrumbs.slice(breadcrumbs.length - MAX_BREADCRUMBS)
  }
}

export function getLastBreadcrumbs(count: number): BreadcrumbEntry[] {
  return breadcrumbs.slice(Math.max(0, breadcrumbs.length - count))
}

export function clearBreadcrumbs(): void {
  breadcrumbs = []
  currentScreen = undefined
}

export const bc = {
  action: (name: string, data?: Record<string, unknown>) => addBreadcrumb('action', name, data),
  state:  (name: string, data?: Record<string, unknown>) => addBreadcrumb('state', name, data),
  nav:    (screen: string) => setCurrentScreen(screen),
  error:  (type: string, data?: Record<string, unknown>) => addBreadcrumb('error', type, data),
}
