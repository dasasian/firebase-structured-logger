import type { BreadcrumbEntry, NavigationLabels } from '../shared/types'
import { warnDeprecated } from '../shared/deprecate'

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

/**
 * Set by `enableNavigation()` and `navigatedTo()` (`client/navigation.ts`), never by
 * the core itself — the setter a helper hands data through, mirroring `setCurrentRoute`.
 * Once true, the legacy `bc.nav`/`setScreen` path is ignored: one page change must give
 * exactly one `nav` breadcrumb, never two for the same event.
 */
export function setNavigationEnabled(enabled: boolean): void {
  navigationEnabled = enabled
}

let navigationEnabled = false

let adapterActive = false
let historyWrapperWired = false
let adapterWinsWarned = false

function warnAdapterWins(): void {
  if (adapterWinsWarned) return
  adapterWinsWarned = true
  console.warn(
    '[fsl] a router adapter and enableNavigation() are both active — the adapter wins, and the history wrapper stops recording.',
  )
}

/** Called by a router adapter's own registration/`stop()` — never by the core itself. */
export function setAdapterActive(active: boolean): void {
  if (active && historyWrapperWired) warnAdapterWins()
  adapterActive = active
}

export function isAdapterActive(): boolean {
  return adapterActive
}

/** Called once, by `enableNavigation()`, the first time it wraps `history`. */
export function noteHistoryWrapperWired(): void {
  if (adapterActive) warnAdapterWins()
  historyWrapperWired = true
}

function recordScreenChange(screen: string): void {
  if (navigationEnabled) return
  currentScreen = screen
  addBreadcrumb('nav', `navigate_${screen}`)
}

/** @deprecated Use `enableNavigation()`, or `navigatedTo()` without URL routing. */
export function setCurrentScreen(screen: string): void {
  warnDeprecated('setScreen', 'enableNavigation(), or navigatedTo() without URL routing')
  recordScreenChange(screen)
}

function legacyNav(screen: string): void {
  warnDeprecated('bc.nav', 'enableNavigation(), or navigatedTo() without URL routing')
  recordScreenChange(screen)
}

export function getCurrentScreen(): string | undefined {
  return currentScreen
}

let currentRoute: NavigationLabels | undefined

/**
 * Called by `enableNavigation()` and `navigatedTo()` (`client/navigation.ts`) on every
 * page change — never by the core itself. Mirrors `setNavigationEnabled`: the one-way
 * setter a helper hands data through, rather than the core reaching out to the helper.
 * Adds one `nav` breadcrumb named after `labels.screen`, else `labels.route`, else
 * `labels.path`; `labels` itself is stored exactly as given, so a field left out of it
 * stays absent from the entry labels built from `getCurrentRoute()`.
 */
export function setCurrentRoute(labels: NavigationLabels): void {
  currentRoute = labels
  const data: Record<string, unknown> = {}
  if (labels.route !== undefined) data.route = labels.route
  if (labels.path !== undefined) data.path = labels.path
  addBreadcrumb('nav', labels.screen ?? labels.route ?? labels.path ?? '', Object.keys(data).length > 0 ? data : undefined)
}

/** The current page's navigation labels, or `undefined` when navigation was never turned on. */
export function getCurrentRoute(): NavigationLabels | undefined {
  return currentRoute
}

let viewReader: (() => string | undefined) | undefined

/** Set by `enableViews()`, never by the core itself. A later call replaces the reader. */
export function setViewReader(reader: () => string | undefined): void {
  viewReader = reader
}

/** What was on screen right now, or `undefined` when `enableViews()` was never called. */
export function getActiveView(): string | undefined {
  return viewReader?.()
}

/**
 * The screen to label an entry with right now — navigation's, when it has one,
 * else the legacy `setScreen`/`bc.nav` value. Written once so the label and the
 * repeat signature can never read two different answers to the same question.
 */
export function getActiveScreen(): string | undefined {
  return currentRoute?.screen ?? currentScreen
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

/** Clears the trail, the legacy screen, and the current route. */
export function resetBreadcrumbSession(): void {
  clearBreadcrumbs()
  currentRoute = undefined
}

/**
 * One way in for each kind of breadcrumb (CLAUDE.md, "Where the user is"). `nav` and
 * `error` are deprecated — `enableNavigation()`/`navigatedTo()` and `handledError`
 * replace them — and each still works, warning once.
 */
export const bc = {
  action: (name: string, data?: Record<string, unknown>) => addBreadcrumb('action', name, data),
  state: (name: string, data?: Record<string, unknown>) => addBreadcrumb('state', name, data),
  /** @deprecated Use `enableNavigation()`, or `navigatedTo()` without URL routing. */
  nav: (screen: string) => legacyNav(screen),
  /** @deprecated Use `bc.handledError` — only for an error your code handled and did not log. */
  error: (type: string, data?: Record<string, unknown>) => {
    warnDeprecated('bc.error', 'bc.handledError')
    addBreadcrumb('error', type, data)
  },
  /** An error your code handled and chose not to log — a clue if something else goes wrong. */
  handledError: (type: string, data?: Record<string, unknown>) => addBreadcrumb('error', type, data),
}
