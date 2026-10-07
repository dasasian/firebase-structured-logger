import { setCurrentRoute } from '../breadcrumbs'
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

function labelsFromState(state: ReactRouterStateLike): NavigationLabels {
  const route = joinRoutePath(state.matches)
  return { route, screen: deepestHandleScreen(state.matches) ?? route, path: state.location.pathname }
}

/**
 * Needs a data router (`createBrowserRouter`, `createHashRouter`, `createMemoryRouter`).
 * One crumb per `location.key`, so a redirect records only the page it ends on. `path`
 * keeps the `basename`; `route` never has it. A second call stops the first.
 */
export function enableReactRouterNavigation(
  router: ReactRouterLike,
  options: ReactRouterNavigationOptions = {},
): () => void {
  const adjustLabels = createAdjuster(options.adjust)
  let stopped = false
  let lastKey = router.state.location.key

  const unsubscribe = router.subscribe((state) => {
    if (state.location.key === lastKey) return
    lastKey = state.location.key
    setCurrentRoute(adjustLabels(labelsFromState(state)))
  })

  function stop(): void {
    if (stopped) return
    stopped = true
    unsubscribe()
    clearAdapterStop(stop)
  }

  registerAdapterStop(stop)

  if (router.state.matches.length > 0) {
    setCurrentRoute(adjustLabels(labelsFromState(router.state)))
  }

  return stop
}
