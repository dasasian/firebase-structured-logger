import { setCurrentRoute, setNavigationEnabled, isAdapterActive, noteHistoryWrapperWired } from './breadcrumbs'
import { warnDeprecated } from '../shared/deprecate'
import type { NavigationLabels } from '../shared/types'

/**
 * `@dasasian/firebase-structured-logger/client/navigation` — its own entry point
 * (see CLAUDE.md, "Optional client helpers are separate entry points") so an app
 * that never imports it ships none of this, whatever its bundler. Call `enableNavigation()`
 * once, before or after `initLogger`. See README, "Navigation, automatically".
 */
export interface NavigationOptions {
  /**
   * The single customisation point. Receives the real path, already stripped of its
   * query string and any non-route fragment, and returns the labels for that page —
   * used exactly as returned; a field left out is not logged. Must be synchronous: it
   * runs inside your router's own `pushState`. If it throws, that page gets
   * `defaultLabelsFor(path)` and the console warns once, however often it throws.
   */
  labelsFor?: (path: string) => NavigationLabels
  /** @deprecated Use `labelsFor`. Names the route the way your router does. Returning `undefined` falls back to the id rule. */
  routeFor?: (path: string) => string | undefined
  /**
   * @deprecated Use `labelsFor`. Runs on the real path before it is stored and before
   * `routeFor`/the id rule sees it — for paths that can themselves hold personal data,
   * e.g. `/users/jane@example.com`.
   */
  cleanPath?: (path: string) => string
  /** @deprecated Use `labelsFor`. `false` omits the `path` label, and keeps the real path out of breadcrumbs too. */
  path?: false
}

const ALL_DIGITS = /^\d+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX = /^[0-9a-f]{16,}$/i
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i

function isIdSegment(segment: string): boolean {
  return segment !== '' && (ALL_DIGITS.test(segment) || UUID.test(segment) || LONG_HEX.test(segment) || ULID.test(segment))
}

/**
 * The route pattern for a path: a segment counts as an id, and becomes `:id`, when it
 * is all digits, a UUID, hex of 16 or more characters, or a 26-character ULID (Crockford
 * base32 — digits and letters, excluding I, L, O, U). Anything else — a slug like
 * `my-post`, a version segment like `v2`, a short code — is kept exactly as written:
 * no rule tells those from a page name reliably, which is what `routeFor` is for.
 */
export function routePattern(path: string): string {
  return path
    .split('/')
    .map((segment) => (isIdSegment(segment) ? ':id' : segment))
    .join('/')
}

interface LocationLike {
  pathname: string
  hash: string
}

/**
 * The real path: the query string never leaves the browser, and neither does a
 * fragment unless it is itself a route. `#/orders/1042` is read as the path;
 * `#section-3` or `#access_token=...` is dropped.
 */
function realPath(location: LocationLike): string {
  const raw = location.hash.startsWith('#/') ? location.hash.slice(1) : location.pathname
  return raw.split('?')[0] ?? raw
}

/**
 * The labels `enableNavigation()` gives when no `labelsFor` is passed: the id-rule
 * `route`, `screen` equal to `route`, the stripped `path`, and the deprecated
 * `routeSource: 'pattern'`.
 */
export function defaultLabelsFor(path: string): NavigationLabels {
  const route = routePattern(path)
  return { route, screen: route, path, routeSource: 'pattern' }
}

function legacyLabelsFor(path: string): NavigationLabels {
  const cleaned = options.cleanPath ? options.cleanPath(path) : path
  const fromRouter = options.routeFor?.(cleaned)
  const route = fromRouter ?? routePattern(cleaned)
  const routeSource: NavigationLabels['routeSource'] = fromRouter !== undefined ? 'router' : 'pattern'
  return options.path === false ? { route, routeSource } : { route, path: cleaned, routeSource }
}

let options: NavigationOptions = {}
let wired = false
let labelsForThrew = false

function resolveLabelsFor(path: string): NavigationLabels {
  if (options.labelsFor) {
    try {
      return options.labelsFor(path)
    } catch (err) {
      if (!labelsForThrew) {
        labelsForThrew = true
        console.warn('[fsl] labelsFor threw — using the default labels for this page:', err instanceof Error ? err.message : err)
      }
      return defaultLabelsFor(path)
    }
  }
  if (options.routeFor !== undefined || options.cleanPath !== undefined || options.path === false) {
    return legacyLabelsFor(path)
  }
  return defaultLabelsFor(path)
}

function recordNavigation(): void {
  if (isAdapterActive()) return
  setCurrentRoute(resolveLabelsFor(realPath(location)))
}

/**
 * The same breadcrumb and labels as automatic navigation (`enableNavigation()`), for a
 * screen that changes without the URL changing. Counts as navigation being on, the same
 * as `enableNavigation()` — the legacy `bc.nav`/`setScreen` path is ignored from then on.
 */
export function navigatedTo(screen: string, extra: { route?: string; path?: string } = {}): void {
  setNavigationEnabled(true)
  const labels: NavigationLabels = { screen }
  if (extra.route !== undefined) labels.route = extra.route
  if (extra.path !== undefined) labels.path = extra.path
  setCurrentRoute(labels)
}

// A Symbol.for registration, not a module-local Symbol — a second copy of this module
// (two bundles on one page) must still recognize the first copy's wrapper as "ours".
const FSL_WRAPPED = Symbol.for('fsl.wrappedHistoryMethod')

type HistoryMethodName = 'pushState' | 'replaceState'
type HistoryMethod = (this: History, ...args: unknown[]) => unknown
type WrappableHistoryMethod = HistoryMethod & { [FSL_WRAPPED]?: boolean }

/**
 * Wraps `history[name]` exactly once, ever — a later call finds `FSL_WRAPPED` already
 * set and leaves it alone. The wrapper calls the original with the same arguments and
 * `this`, returns its result, and only then records the navigation — so it never
 * disturbs a wrapper another tool installed before (captured here as "the original")
 * or after (which will in turn capture this wrapper as its own "original") this one.
 */
function wrapHistoryMethod(name: HistoryMethodName): void {
  const target = history as unknown as Record<HistoryMethodName, WrappableHistoryMethod>
  const original = target[name]
  if (original[FSL_WRAPPED]) return
  const wrapped: WrappableHistoryMethod = function (this: History, ...args: unknown[]) {
    const result = original.apply(this, args)
    recordNavigation()
    return result
  }
  wrapped[FSL_WRAPPED] = true
  target[name] = wrapped
}

/**
 * Turns on automatic navigation tracking for the session. The first call wraps
 * `history.pushState`/`replaceState` and listens for `popstate`, then records the
 * current page; a later call only replaces `options` — the module-scoped-state rule —
 * and does not wrap again. Does nothing outside a browser (Node, SSR), and touches no
 * browser global until it runs, so merely importing this module is always safe.
 */
export function enableNavigation(newOptions: NavigationOptions = {}): void {
  options = newOptions
  labelsForThrew = false
  setNavigationEnabled(true)
  if (newOptions.routeFor !== undefined) warnDeprecated('routeFor', 'labelsFor')
  if (newOptions.cleanPath !== undefined) warnDeprecated('cleanPath', 'labelsFor')
  if (newOptions.path === false) warnDeprecated('path: false', 'labelsFor')
  if (typeof window === 'undefined') return
  if (wired) return
  wired = true
  noteHistoryWrapperWired()
  wrapHistoryMethod('pushState')
  wrapHistoryMethod('replaceState')
  window.addEventListener('popstate', recordNavigation)
  recordNavigation()
}
