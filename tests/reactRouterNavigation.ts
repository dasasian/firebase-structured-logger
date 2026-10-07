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
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1042/nameless'] })
  const stop = enableReactRouterNavigation(router)

  const nav = getCurrentRoute()
  assert(`[${major.label}] route is the deepest match's joined path`, nav?.route === '/orders/:id/nameless', JSON.stringify(nav))
  assert(`[${major.label}] screen is the deepest match that HAS a handle.screen`, nav?.screen === 'Order', JSON.stringify(nav))

  stop()
}

async function testIndexAndPathlessRoutesAddNoSegmentAndAbsoluteChildResets(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: index route adds no segment; pathless layout adds no segment; absolute child resets the join`)
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

async function testLoaderRedirectCollapsesToOneCrumbForTheFinalPage(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: a loader redirect('/login') -> one crumb, for /login, not the page it redirected from`)
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
  const router = major.createMemoryRouter(makeRoutes(major.redirect), { initialEntries: ['/orders/1/items'] })
  const stop = enableReactRouterNavigation(router)

  const before = crumbCount()
  stop()
  await router.navigate('/orders/2/items')
  assert(`[${major.label}] no crumb was added after stop()`, crumbCount() === before, `got ${crumbCount() - before}`)
}

async function testAdapterDisablesLegacyBcNav(major: RouterMajor) {
  console.log(`\n[${major.label}] Test: with only the adapter on, bc.nav/setScreen are ignored — one crumb per change, not two`)
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
