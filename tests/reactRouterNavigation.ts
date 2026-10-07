/**
 * `enableReactRouterNavigation` (#62) — `@dasasian/firebase-structured-logger/client/navigation/react-router`.
 *
 * Drives real data routers (`createMemoryRouter`) from both supported majors, installed
 * as devDependencies through npm aliases (`react-router-6`, `react-router-7`) so neither
 * shadows the other in `node_modules`. The per-router assertions run once per major, in
 * one loop, since the adapter's contract does not vary between them; the process-wide
 * interactions with `enableNavigation()` and the legacy `bc.nav`/`setScreen` path are
 * module-global state (CLAUDE.md, "Module-scoped state"), so they run exactly once,
 * against the first major, the same way `vueRouterNavigation.ts` runs them once.
 *
 * `createMemoryRouter` matches and reports `state.location.pathname` WITH any configured
 * `basename` included — confirmed by experiment, not assumed from the docs, which only
 * say `path` is `location.pathname`. `route`, built by joining each match's own
 * `route.path`, never carries the basename, because those path segments are the route
 * config's own relative/absolute patterns and never include it.
 *
 * Run: npx tsx tests/reactRouterNavigation.ts
 */

import '../tests/browserStubs.js'
import { assert, reportResults } from './testHelpers.js'
import { enableReactRouterNavigation, type ReactRouterLike } from '../src/client/navigation/react-router.js'
import { enableNavigation } from '../src/client/navigation.js'
import { getCurrentRoute, getLastBreadcrumbs, bc } from '../src/client/breadcrumbs.js'
import { resetSession } from '../src/testing.js'

interface RouterMajor {
  label: string
  createMemoryRouter: (routes: unknown[], opts: { initialEntries: string[]; basename?: string }) => ReactRouterLike & {
    navigate(to: string): Promise<void>
    revalidate(): Promise<void>
  }
  redirect: (to: string) => never
}

async function loadMajor(label: string, pkg: string): Promise<RouterMajor> {
  const mod = (await import(pkg)) as {
    createMemoryRouter: RouterMajor['createMemoryRouter']
    redirect: RouterMajor['redirect']
  }
  return { label, createMemoryRouter: mod.createMemoryRouter, redirect: mod.redirect }
}

function crumbCount(): number {
  return getLastBreadcrumbs(1000).length
}

async function captureWarningsAsync(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = []
  const real = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    await fn()
  } finally {
    console.warn = real
  }
  return warnings
}

function makeRoutes(redirect: RouterMajor['redirect']) {
  return [
    {
      path: 'orders/:id',
      handle: { screen: 'Order' },
      children: [
        { index: true, handle: { screen: 'OrderIndex' } },
        { path: 'items', handle: { screen: 'OrderItems' } },
        { path: 'nameless' },
      ],
    },
    { path: 'login', handle: { screen: 'Login' } },
    { path: 'users/:id', handle: { screen: 'UserProfile' } },
    {
      // pathless layout — contributes no segment of its own
      children: [{ path: '/override', handle: { screen: 'Override' } }],
    },
    { path: 'redirecting', loader: async () => { throw redirect('/login') } },
    { path: 'revalidating', loader: async () => ({ ok: true }), handle: { screen: 'Revalidating' } },
  ]
}

async function testNestedMatchGivesOneCrumbWithTheRightLabels(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: /orders/1042/items -> one crumb, route/screen/path`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1042/items'] })
  const before = crumbCount()
  const stop = enableReactRouterNavigation(router)

  assert(`[${major.label}] the initial match records one crumb`, crumbCount() === before + 1, `got ${crumbCount() - before}`)
  const nav = getCurrentRoute()
  assert(`[${major.label}] route is joined from each match's path`, nav?.route === '/orders/:id/items', JSON.stringify(nav))
  assert(`[${major.label}] screen is the deepest match's handle.screen`, nav?.screen === 'OrderItems', JSON.stringify(nav))
  assert(`[${major.label}] path is location.pathname`, nav?.path === '/orders/1042/items', JSON.stringify(nav))

  stop()
}

async function testNestedRouteWalksUpToTheDeepestHandleScreen(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a leaf with no handle under a named parent -> screen is the parent's`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1042/nameless'] })
  const stop = enableReactRouterNavigation(router)

  const nav = getCurrentRoute()
  assert(`[${major.label}] route is the deepest match's joined path`, nav?.route === '/orders/:id/nameless', JSON.stringify(nav))
  assert(`[${major.label}] screen is the deepest match that HAS a handle.screen`, nav?.screen === 'Order', JSON.stringify(nav))

  stop()
}

async function testIndexAndPathlessRoutesAddNoSegmentAndAbsoluteChildResets(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: index route adds no segment; pathless layout adds no segment; absolute child resets the join`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1042/items'] })
  const stop = enableReactRouterNavigation(router)

  await router.navigate('/orders/1042')
  assert(`[${major.label}] the index route adds no segment of its own`, getCurrentRoute()?.route === '/orders/:id', JSON.stringify(getCurrentRoute()))

  await router.navigate('/override')
  assert(
    `[${major.label}] an absolute child path resets the join rather than appending to the pathless layout`,
    getCurrentRoute()?.route === '/override',
    JSON.stringify(getCurrentRoute()),
  )

  stop()
}

async function testBasenameIsExcludedFromRouteButIncludedInPath(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: basename '/app' -> route has no /app; path is location.pathname (basename included)`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), {
    initialEntries: ['/app/orders/1042/items'],
    basename: '/app',
  })
  const stop = enableReactRouterNavigation(router)

  const nav = getCurrentRoute()
  assert(`[${major.label}] route carries no basename`, nav?.route === '/orders/:id/items', JSON.stringify(nav))
  assert(`[${major.label}] path is location.pathname, basename included`, nav?.path === '/app/orders/1042/items', JSON.stringify(nav))

  stop()
}

function waitForInitialized(router: ReactRouterLike): Promise<void> {
  if (router.state.initialized) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (!state.initialized) return
      unsubscribe()
      resolve()
    })
  })
}

async function testFirstLoadRedirectRecordsOnlyTheFinalPage(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a first-load loader redirect -> one crumb, for the page it ends on, not the start page`)
  resetSession()
  const routes = [
    { path: '/', loader: () => { throw major.redirect('/rooms') }, handle: { screen: 'Home' } },
    { path: '/rooms', handle: { screen: 'Rooms' } },
  ]
  const router = major.createMemoryRouter(routes, { initialEntries: ['/'] })
  const before = crumbCount()
  const stop = enableReactRouterNavigation(router)
  await waitForInitialized(router)

  assert(`[${major.label}] exactly one crumb for the whole first-load redirect`, crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert(`[${major.label}] the recorded page is the one the redirect ends on`, getCurrentRoute()?.screen === 'Rooms', JSON.stringify(getCurrentRoute()))

  stop()
}

async function testFirstLoadWithLoaderAndNoRedirectRecordsThatPage(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a first load with a loader and no redirect -> exactly one crumb, for that page`)
  resetSession()
  const routes = [{ path: '/', loader: async () => ({ ok: true }), handle: { screen: 'Home' } }]
  const router = major.createMemoryRouter(routes, { initialEntries: ['/'] })
  const before = crumbCount()
  const stop = enableReactRouterNavigation(router)
  await waitForInitialized(router)

  assert(`[${major.label}] exactly one crumb for the first load`, crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert(`[${major.label}] the recorded page is the one page there is`, getCurrentRoute()?.screen === 'Home', JSON.stringify(getCurrentRoute()))

  stop()
}

async function testAlreadyInitializedRouterRecordsItsPageOnce(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a router already initialized when the adapter is enabled -> its current page recorded once`)
  resetSession()
  const routes = [{ path: '/', handle: { screen: 'Home' } }]
  const router = major.createMemoryRouter(routes, { initialEntries: ['/'] })
  assert(`[${major.label}] a router with no loaders is initialized synchronously by createMemoryRouter`, router.state.initialized === true, String(router.state.initialized))

  const before = crumbCount()
  const stop = enableReactRouterNavigation(router)

  assert(`[${major.label}] its current page is recorded exactly once`, crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert(`[${major.label}] the recorded page is the router's current page`, getCurrentRoute()?.screen === 'Home', JSON.stringify(getCurrentRoute()))

  stop()
}

async function testEntryBeforeInitializationHasNoRouteOrScreen(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: before the router initializes, there is no recorded route/screen yet`)
  resetSession()
  const routes = [{ path: '/', loader: async () => ({ ok: true }), handle: { screen: 'Home' } }]
  const router = major.createMemoryRouter(routes, { initialEntries: ['/'] })
  assert(`[${major.label}] the router has not initialized yet`, router.state.initialized === false, String(router.state.initialized))

  const navBefore = getCurrentRoute()
  const stop = enableReactRouterNavigation(router)

  assert(
    `[${major.label}] enabling the adapter before initialization records nothing yet`,
    getCurrentRoute() === navBefore,
    JSON.stringify(getCurrentRoute()),
  )

  stop()
}

async function testLoaderRedirectCollapsesToOneCrumbForTheFinalPage(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a loader redirect('/login') -> one crumb, for /login, not the page it redirected from`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1042/items'] })
  const stop = enableReactRouterNavigation(router)

  const before = crumbCount()
  await router.navigate('/redirecting')
  assert(`[${major.label}] exactly one crumb for the whole redirect`, crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert(`[${major.label}] the recorded page is the final one`, getCurrentRoute()?.route === '/login', JSON.stringify(getCurrentRoute()))

  stop()
}

async function testRevalidationWithTheSameLocationKeyAddsNoCrumb(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a revalidation that keeps the same location.key -> no crumb`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1042/items'] })
  const stop = enableReactRouterNavigation(router)
  await router.navigate('/revalidating')

  const before = crumbCount()
  await router.revalidate()
  assert(`[${major.label}] no crumb was added for the revalidation`, crumbCount() === before, `got ${crumbCount() - before}`)

  stop()
}

async function testAdjustMasksAnEmail(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: adjust masks an email in path`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1042/items'] })
  const stop = enableReactRouterNavigation(router, {
    adjust: (labels) => ({ ...labels, path: labels.path?.replace(/[^/]+@[^/]+/g, ':email') }),
  })

  await router.navigate('/users/jane@example.com')
  const nav = getCurrentRoute()
  assert(`[${major.label}] the email is masked in path`, nav?.path === '/users/:email', JSON.stringify(nav))
  assert(`[${major.label}] route is unaffected by adjust`, nav?.route === '/users/:id', JSON.stringify(nav))

  stop()
}

async function testThrowingAdjustWarnsOnceAndKeepsTheRoutersLabels(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a throwing adjust -> unadjusted labels, warns exactly once however often it throws`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1042/items'] })

  let stop: (() => void) | undefined
  const warnings = await captureWarningsAsync(async () => {
    // The initial, synchronous record on registration throws too — captured here
    // so all four throws (one at registration, three on navigate) count together.
    stop = enableReactRouterNavigation(router, {
      adjust: () => { throw new Error('boom') },
    })
    await router.navigate('/orders/1/items')
    await router.navigate('/orders/2/items')
    await router.navigate('/orders/3/items')
  })

  const nav = getCurrentRoute()
  assert(
    `[${major.label}] the router's own labels are used despite the throw`,
    nav?.route === '/orders/:id/items' && nav?.screen === 'OrderItems',
    JSON.stringify(nav),
  )
  const matching = warnings.filter((w) => w.includes('adjust'))
  assert(`[${major.label}] exactly one warning across four throws`, matching.length === 1, JSON.stringify(warnings))

  stop?.()
}

async function testSecondAdapterCallStopsTheFirst(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a second enableReactRouterNavigation call stops the first — only the second records`)
  resetSession()
  const routerA = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1/items'] })
  const stopA = enableReactRouterNavigation(routerA)

  const routerB = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/login'] })
  const stopB = enableReactRouterNavigation(routerB)

  const before = crumbCount()
  await routerA.navigate('/orders/2/items')
  assert(`[${major.label}] the stopped (first) adapter no longer records`, crumbCount() === before, `got ${crumbCount() - before}`)

  await routerB.navigate('/orders/3/items')
  assert(`[${major.label}] the active (second) adapter still records`, crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert(`[${major.label}] the recorded route is from the second router`, getCurrentRoute()?.path === '/orders/3/items', JSON.stringify(getCurrentRoute()))

  void stopA
  stopB()
}

async function testStopGivesNoMoreCrumbs(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: stop() -> no more crumbs`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1/items'] })
  const stop = enableReactRouterNavigation(router)

  const before = crumbCount()
  stop()
  await router.navigate('/orders/2/items')
  assert(`[${major.label}] no crumb was added after stop()`, crumbCount() === before, `got ${crumbCount() - before}`)
}

async function testAdapterDisablesLegacyBcNav(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: with only the adapter on, bc.nav/setScreen are ignored — one crumb per change, not two`)
  resetSession()
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1/items'] })
  const stop = enableReactRouterNavigation(router)

  const before = crumbCount()
  const warnings = await captureWarningsAsync(async () => {
    bc.nav('IgnoredScreen')
    await router.navigate('/orders/40/items')
  })

  assert(`[${major.label}] exactly one crumb for the one navigation`, crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert(`[${major.label}] bc.nav still warns once, even though it is ignored`, warnings.some((w) => w.includes('"bc.nav"')), JSON.stringify(warnings))

  stop()
}

async function testAdapterWinsOverEnableNavigation(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: an adapter wins over enableNavigation() — one warning, and the history wrapper stops recording`)
  resetSession()
  enableNavigation()
  history.pushState({}, '', '/before-adapter')
  assert(`[${major.label}] enableNavigation recorded before any adapter`, getCurrentRoute()?.path === '/before-adapter', JSON.stringify(getCurrentRoute()))

  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/5/items'] })

  let stop: (() => void) | undefined
  const warnings = await captureWarningsAsync(async () => {
    stop = enableReactRouterNavigation(router)
  })
  assert(`[${major.label}] one warning that the adapter wins`, warnings.filter((w) => w.includes('adapter wins')).length === 1, JSON.stringify(warnings))

  const before = crumbCount()
  history.pushState({}, '', '/ignored-by-history')
  assert(`[${major.label}] history.pushState no longer records once the adapter is active`, crumbCount() === before, `got ${crumbCount() - before}`)

  await router.navigate('/orders/6/items')
  assert(`[${major.label}] exactly one crumb for the router navigation`, crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert(`[${major.label}] the recorded route is the router's, not history's`, getCurrentRoute()?.path === '/orders/6/items', JSON.stringify(getCurrentRoute()))

  stop?.()
}

/**
 * Every case here calls `resetSession()` first (`/testing`, #64), so each starts with
 * an empty trail and a full budget — order no longer matters, and a run of more than
 * `MAX_BREADCRUMBS` cases in this file can no longer pin a `crumbCount()` delta at the
 * cap the way it used to.
 */
async function runPerMajorCases(major: RouterMajor): Promise<void> {
  await testNestedMatchGivesOneCrumbWithTheRightLabels(major)
  await testNestedRouteWalksUpToTheDeepestHandleScreen(major)
  await testIndexAndPathlessRoutesAddNoSegmentAndAbsoluteChildResets(major)
  await testBasenameIsExcludedFromRouteButIncludedInPath(major)
  await testLoaderRedirectCollapsesToOneCrumbForTheFinalPage(major)
  await testRevalidationWithTheSameLocationKeyAddsNoCrumb(major)
  await testAdjustMasksAnEmail(major)
  await testThrowingAdjustWarnsOnceAndKeepsTheRoutersLabels(major)
  await testSecondAdapterCallStopsTheFirst(major)
  await testStopGivesNoMoreCrumbs(major)
  await testFirstLoadRedirectRecordsOnlyTheFinalPage(major)
  await testFirstLoadWithLoaderAndNoRedirectRecordsThatPage(major)
  await testAlreadyInitializedRouterRecordsItsPageOnce(major)
  await testEntryBeforeInitializationHasNoRouteOrScreen(major)
}

async function run() {
  const majors = [await loadMajor('react-router 6', 'react-router-6'), await loadMajor('react-router 7', 'react-router-7')]

  // Process-wide state (CLAUDE.md, "Module-scoped state") — run exactly once, against
  // the first major, before anything else has turned navigation or an adapter on.
  await testAdapterDisablesLegacyBcNav(majors[0])
  await testAdapterWinsOverEnableNavigation(majors[0])

  for (const major of majors) {
    await runPerMajorCases(major)
  }

  reportResults()
}

run()
