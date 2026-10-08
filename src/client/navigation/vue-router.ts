import { setCurrentRoute } from '../breadcrumbs'
import { getLoggerForFrameworkHook } from '../logger'
import { createAdjuster, registerAdapterStop, clearAdapterStop } from './adapterShared'
import type { NavigationLabels } from '../../shared/types'

/** `path` is already the deepest match's full resolved pattern, e.g. `/orders/:id/items`. */
export interface VueRouteRecordLike {
  path: string
  name?: string | symbol
}

export interface VueRouteLocationLike {
  path: string
  matched: VueRouteRecordLike[]
}

export interface VueRouterLike {
  afterEach(
    guard: (to: VueRouteLocationLike, from: VueRouteLocationLike, failure: unknown) => void,
  ): () => void
  onError(handler: (error: unknown, to: VueRouteLocationLike) => void): () => void
  currentRoute: { value: VueRouteLocationLike }
}

export interface VueRouterNavigationOptions {
  /** A throwing `adjust` falls back to the router's own labels, warning once. */
  adjust?: (labels: NavigationLabels) => NavigationLabels
}

function deepestNamedScreen(matched: VueRouteRecordLike[]): string | undefined {
  for (let i = matched.length - 1; i >= 0; i--) {
    const name = matched[i].name
    if (typeof name === 'string') return name
  }
  return undefined
}

function labelsFromRoute(to: VueRouteLocationLike): NavigationLabels {
  const deepest = to.matched[to.matched.length - 1]
  const route = deepest ? deepest.path : to.path
  return { route, screen: deepestNamedScreen(to.matched) ?? route, path: to.path }
}

/**
 * Listens with `router.afterEach`; never wraps `history`. Skips a navigation that
 * failed (`failure` truthy) — a blocked or cancelled one records no crumb. `path` is
 * always `to.path`, never `fullPath`, so a query string or hash never reaches a label.
 * Also logs what `router.onError` reports — a guard that throws, a lazy route that fails to
 * load — as an `ERROR` with `errorType` `RouteError` and the attempted `path` in context.
 * A second call stops the first, and the function returned stops both listeners.
 */
export function enableVueRouterNavigation(
  router: VueRouterLike,
  options: VueRouterNavigationOptions = {},
): () => void {
  const adjustLabels = createAdjuster(options.adjust)
  let stopped = false

  const unregister = router.afterEach((to, _from, failure) => {
    if (failure) return
    setCurrentRoute(adjustLabels(labelsFromRoute(to)))
  })

  const unregisterError = router.onError((error, to) => {
    getLoggerForFrameworkHook()?.error(error, { errorType: 'RouteError' }, { path: to.path })
  })

  function stop(): void {
    if (stopped) return
    stopped = true
    unregister()
    unregisterError()
    clearAdapterStop(stop)
  }

  registerAdapterStop(stop)

  const startingRoute = router.currentRoute.value
  if (startingRoute.matched.length > 0) {
    setCurrentRoute(adjustLabels(labelsFromRoute(startingRoute)))
  }

  return stop
}
