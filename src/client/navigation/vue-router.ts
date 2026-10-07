import { setCurrentRoute } from '../breadcrumbs'
import { createAdjuster, registerAdapterStop, clearAdapterStop } from './adapterShared'
import type { NavigationLabels } from '../../shared/types'

/**
 * The structural slice of a Vue Router 4 `RouteRecordNormalized` this adapter reads.
 * `path` is already the deepest match's full resolved pattern, e.g. `/orders/:id/items`.
 */
export interface VueRouteRecordLike {
  path: string
  name?: string | symbol
}

/** The structural slice of a Vue Router 4 `RouteLocationNormalized` this adapter reads. */
export interface VueRouteLocationLike {
  path: string
  matched: VueRouteRecordLike[]
}

/**
 * The structural slice of a Vue Router 4 `Router` this adapter reads — no dependency
 * or peer dependency on `vue-router`, which is a devDependency for tests only.
 */
export interface VueRouterLike {
  afterEach(
    guard: (to: VueRouteLocationLike, from: VueRouteLocationLike, failure: unknown) => void,
  ): () => void
  currentRoute: { value: VueRouteLocationLike }
}

export interface VueRouterNavigationOptions {
  /** Runs last; its answer is used as returned. A throwing `adjust` logs the router's own labels, warning once. */
  adjust?: (labels: NavigationLabels) => NavigationLabels
}

/**
 * `screen` is the `name` of the deepest matched record whose name is a string —
 * a symbol name (Vue Router's internal ones) is skipped, not treated as a match.
 */
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
 * `enableVueRouterNavigation(router, { adjust? })` —
 * `@dasasian/firebase-structured-logger/client/navigation/vue-router`.
 *
 * Reads Vue Router 4's own match instead of guessing the route from the path
 * (README, "With React Router or Vue Router — an adapter"; CLAUDE.md, "Where the
 * user is"). Listens with `router.afterEach`, never wraps `history`. Skips a
 * navigation that failed (`failure` truthy) — a blocked or cancelled one records
 * no crumb. `path` is always `to.path`, never `fullPath`, so a query string or
 * hash never reaches a label.
 *
 * A second call stops the first, and it wins over `enableNavigation()` — if that
 * ran too, its `history` wrapper stops recording, with one console warning.
 *
 * Returns `stop()`.
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

  function stop(): void {
    if (stopped) return
    stopped = true
    unregister()
    clearAdapterStop(stop)
  }

  registerAdapterStop(stop)

  // The initial route is skipped at Vue Router's own START_LOCATION, which has no
  // matches — the first real navigation reaches us through afterEach instead.
  const current = router.currentRoute.value
  if (current.matched.length > 0) {
    setCurrentRoute(adjustLabels(labelsFromRoute(current)))
  }

  return stop
}
