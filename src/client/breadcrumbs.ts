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

/**
 * Drop anything past the age cutoff.
 *
 * Applied on READ as well as on write. Expiring only on write means the cutoff
 * lapses exactly when nothing is happening — a user who goes idle for ten
 * minutes and then hits an error sends a trail of ten-minute-old steps
 * presented as the path that led there. The steps before a pause are rarely
 * the ones that explain what happened after it.
 *
 * Entries are appended in timestamp order, so the array only needs rebuilding
 * when the oldest one has actually aged out.
 */
function unexpired(entries: BreadcrumbEntry[], now: number): BreadcrumbEntry[] {
  const cutoff = now - MAX_AGE_MS
  if (entries.length === 0 || entries[0].timestamp > cutoff) return entries
  return entries.filter((bc) => bc.timestamp > cutoff)
}

export function addBreadcrumb(
  type: BreadcrumbEntry['type'],
  name: string,
  data?: Record<string, unknown>,
): void {
  const now = Date.now()
  breadcrumbs.push({ timestamp: now, type, name, data })
  breadcrumbs = unexpired(breadcrumbs, now)

  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs = breadcrumbs.slice(breadcrumbs.length - MAX_BREADCRUMBS)
  }
}

export function getLastBreadcrumbs(count: number): BreadcrumbEntry[] {
  // Prune the stored trail too, so an idle tab does not hold expired entries
  // alive until the next write.
  breadcrumbs = unexpired(breadcrumbs, Date.now())
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
