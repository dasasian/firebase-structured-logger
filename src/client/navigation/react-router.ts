import { setCurrentRoute } from '../breadcrumbs'
import { getLoggerForFrameworkHook } from '../logger'
import { createAdjuster, registerAdapterStop, clearAdapterStop } from './adapterShared'
import type { NavigationLabels } from '../../shared/types'

export interface ReactRouteLike {
  path?: string
  handle?: unknown
}

export interface ReactRouteMatchLike {
  route: ReactRouteLike
}

export interface ReactRouterStateLike {
  location: { pathname: string; key: string }
  matches: ReactRouteMatchLike[]
  initialized: boolean
  errors: Record<string, unknown> | null
}

export interface ReactRouterLike {
  subscribe(listener: (state: ReactRouterStateLike) => void): () => void
  state: ReactRouterStateLike
}

export interface ReactRouterNavigationOptions {
  /** A throwing `adjust` falls back to the router's own labels, warning once. */
  adjust?: (labels: NavigationLabels) => NavigationLabels
}

function joinRoutePath(matches: ReactRouteMatchLike[]): string {
  let joined = ''
  for (const match of matches) {
    const path = match.route.path
    if (path === undefined) continue
    joined = path.startsWith('/') ? path : `${joined}/${path}`
  }
  return joined.replace(/\/{2,}/g, '/')
}

function deepestHandleScreen(matches: ReactRouteMatchLike[]): string | undefined {
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i].route.handle
    if (handle && typeof handle === 'object' && typeof (handle as { screen?: unknown }).screen === 'string') {
      return (handle as { screen: string }).screen
    }
  }
  return undefined
}

interface ErrorResponseLike {
  status: number
  statusText?: string
}

function asErrorResponse(value: unknown): ErrorResponseLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { status, internal } = value as { status?: unknown; internal?: unknown }
  return typeof status === 'number' && typeof internal === 'boolean' ? (value as ErrorResponseLike) : undefined
}

function logRouteError(routeId: string, thrown: unknown): void {
  const logger = getLoggerForFrameworkHook()
  if (!logger) return
  const labels = { errorType: 'RouteError' }
  const response = asErrorResponse(thrown)
  if (!response) {
    logger.error(thrown, labels, { routeId })
    return
  }
  const message = `Route error ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  const context = { routeId, status: response.status }
  if (response.status >= 500) logger.error(new Error(message), labels, context)
  else logger.warning(message, labels, context)
}

function labelsFromState(state: ReactRouterStateLike): NavigationLabels {
  const route = joinRoutePath(state.matches)
  return { route, screen: deepestHandleScreen(state.matches) ?? route, path: state.location.pathname }
}

/**
 * Needs a data router (`createBrowserRouter`, `createHashRouter`, `createMemoryRouter`).
 * One crumb per page: the first once the router is initialized, then one per
 * `location.key`, so a loader `redirect()` — on first load too — records only the page
 * it ends on, while a `<Navigate>` element records both pages.
 * `path` keeps the `basename`; `route` never has it.
 * Also logs each new entry in `router.state.errors` once, after recording the page: an
 * `Error` or a 5xx response as an `ERROR`, a 4xx response as a `WARNING`, both with
 * `errorType` `RouteError`. A second call stops the first, and the function returned
 * stops both listeners.
 */
export function enableReactRouterNavigation(
  router: ReactRouterLike,
  options: ReactRouterNavigationOptions = {},
): () => void {
  const adjustLabels = createAdjuster(options.adjust)
  let stopped = false
  let lastKey = router.state.location.key
  let sawInitialized = router.state.initialized

  function recordPage(state: ReactRouterStateLike): void {
    if (state.matches.length === 0) return
    setCurrentRoute(adjustLabels(labelsFromState(state)))
  }

  function recordPageOnce(state: ReactRouterStateLike): void {
    if (!sawInitialized) {
      if (!state.initialized) return
      sawInitialized = true
      lastKey = state.location.key
      recordPage(state)
      return
    }
    if (state.location.key === lastKey) return
    lastKey = state.location.key
    recordPage(state)
  }

  const loggedErrors = new Map<string, unknown>()

  function logNewRouteErrors(errors: Record<string, unknown> | null): void {
    const current = errors ?? {}
    for (const routeId of [...loggedErrors.keys()]) {
      if (!(routeId in current)) loggedErrors.delete(routeId)
    }
    for (const [routeId, thrown] of Object.entries(current)) {
      if (loggedErrors.has(routeId) && loggedErrors.get(routeId) === thrown) continue
      loggedErrors.set(routeId, thrown)
      logRouteError(routeId, thrown)
    }
  }

  const unsubscribe = router.subscribe((state) => {
    recordPageOnce(state)
    logNewRouteErrors(state.errors)
  })

  function stop(): void {
    if (stopped) return
    stopped = true
    unsubscribe()
    clearAdapterStop(stop)
  }

  registerAdapterStop(stop)

  if (sawInitialized) {
    recordPage(router.state)
    logNewRouteErrors(router.state.errors)
  }

  return stop
}
