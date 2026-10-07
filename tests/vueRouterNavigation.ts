/**
 * `enableVueRouterNavigation` (#61) — `@dasasian/firebase-structured-logger/client/navigation/vue-router`.
 *
 * Drives a real `createRouter` + `createMemoryHistory`. Vue Router only starts itself
 * automatically when `app.use(router)` mounts an app — these tests never mount one, so
 * each router needs an explicit `push()` before `isReady()` resolves; `enableVueRouterNavigation`
 * is attached either before that first push (exercising "wait for the first afterEach") or
 * after it (exercising "record the current route once at start").
 *
 * Run: npx tsx tests/vueRouterNavigation.ts
 */

import '../tests/browserStubs.js'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { assert, reportResults } from './testHelpers.js'
import { enableVueRouterNavigation } from '../src/client/navigation/vue-router.js'
import { enableNavigation } from '../src/client/navigation.js'
import { getCurrentRoute, getLastBreadcrumbs } from '../src/client/breadcrumbs.js'

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

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'Home', component: {} },
      {
        path: '/orders/:id',
        name: 'Order',
        component: {},
        children: [
          { path: 'items', name: 'OrderItems', component: {} },
          { path: 'nameless', component: {} },
        ],
      },
      { path: '/blocked', name: 'Blocked', component: {} },
      { path: '/users/:id', name: 'UserProfile', component: {} },
      {
        path: '/anon/:id',
        component: {},
        children: [{ path: 'detail', component: {} }],
      },
    ],
  })
}

async function testFirstRealMatchGivesOneCrumbWithTheRightLabels() {
  console.log('\nTest: /orders/1042/items on { path: "/orders/:id/items", name: "OrderItems" } -> one crumb, route/screen/path')
  const router = makeRouter()
  const before = crumbCount()
  const stop = enableVueRouterNavigation(router)
  await router.push('/orders/1042/items')
  await router.isReady()

  assert('exactly one crumb was added', crumbCount() === before + 1, `got ${crumbCount() - before}`)
  const nav = getCurrentRoute()
  assert('route is the full pattern of the deepest match', nav?.route === '/orders/:id/items', JSON.stringify(nav))
  assert('screen is the deepest match\'s name', nav?.screen === 'OrderItems', JSON.stringify(nav))
  assert('path is the real path', nav?.path === '/orders/1042/items', JSON.stringify(nav))

  stop()
}

async function testNestedRouteWalksUpToTheDeepestNamedAncestor() {
  console.log('\nTest: nested routes — an unnamed leaf under a named parent -> screen is the parent\'s name')
  const router = makeRouter()
  const stop = enableVueRouterNavigation(router)
  await router.push('/orders/1042/nameless')
  await router.isReady()

  const nav = getCurrentRoute()
  assert('route is the deepest match\'s pattern', nav?.route === '/orders/:id/nameless', JSON.stringify(nav))
  assert('screen is the deepest NAMED record in the chain, not the leaf', nav?.screen === 'Order', JSON.stringify(nav))

  stop()
}

async function testNestedRouteWithNoNameAnywhereFallsBackToTheRoute() {
  console.log('\nTest: nested routes — no name anywhere in the chain -> screen is the route')
  const router = makeRouter()
  const stop = enableVueRouterNavigation(router)
  await router.push('/anon/5/detail')
  await router.isReady()

  const nav = getCurrentRoute()
  assert('route is the deepest match\'s pattern', nav?.route === '/anon/:id/detail', JSON.stringify(nav))
  assert('screen falls back to the route since nothing in the chain is named', nav?.screen === '/anon/:id/detail', JSON.stringify(nav))

  stop()
}

async function testGuardReturningFalseGivesNoCrumb() {
  console.log('\nTest: a guard returning false -> no crumb')
  const router = makeRouter()
  router.beforeEach((to) => {
    if (to.path === '/blocked') return false
  })
  await router.push('/orders/1042/items')
  await router.isReady()
  const stop = enableVueRouterNavigation(router)

  const before = crumbCount()
  await router.push('/blocked').catch(() => {})
  assert('no crumb was added for the blocked navigation', crumbCount() === before, `got ${crumbCount() - before}`)
  assert('the recorded route is unchanged', getCurrentRoute()?.path === '/orders/1042/items', JSON.stringify(getCurrentRoute()))

  stop()
}

async function testQueryAndHashNeverAppearInAnyLabel() {
  console.log('\nTest: ?token=x#y never appears in any label')
  const router = makeRouter()
  const stop = enableVueRouterNavigation(router)
  await router.push('/orders/9/items?token=x#y')
  await router.isReady()

  const serialized = JSON.stringify(getCurrentRoute())
  assert('no query string in the labels', !serialized.includes('token'), serialized)
  assert('no hash fragment in the labels', !serialized.includes('#y'), serialized)
  assert('path is the clean path (to.path, never fullPath)', getCurrentRoute()?.path === '/orders/9/items', serialized)

  stop()
}

async function testAdjustMasksAnEmail() {
  console.log('\nTest: adjust masks an email in path')
  const router = makeRouter()
  const stop = enableVueRouterNavigation(router, {
    adjust: (labels) => ({ ...labels, path: labels.path?.replace(/[^/]+@[^/]+/g, ':email') }),
  })
  await router.push('/users/jane@example.com')
  await router.isReady()

  const nav = getCurrentRoute()
  assert('the email is masked in path', nav?.path === '/users/:email', JSON.stringify(nav))
  assert('route is unaffected by adjust', nav?.route === '/users/:id', JSON.stringify(nav))

  stop()
}

async function testThrowingAdjustWarnsOnceAndKeepsTheRoutersLabels() {
  console.log('\nTest: a throwing adjust -> unadjusted labels, warns exactly once however often it throws')
  const router = makeRouter()
  const stop = enableVueRouterNavigation(router, {
    adjust: () => {
      throw new Error('boom')
    },
  })

  const warnings = await captureWarningsAsync(async () => {
    await router.push('/orders/1/items')
    await router.push('/orders/2/items')
    await router.push('/orders/3/items')
  })

  const nav = getCurrentRoute()
  assert(
    'the router\'s own labels are used despite the throw',
    nav?.route === '/orders/:id/items' && nav?.screen === 'OrderItems',
    JSON.stringify(nav),
  )
  const matching = warnings.filter((w) => w.includes('adjust'))
  assert('exactly one warning across three throws', matching.length === 1, JSON.stringify(warnings))

  stop()
}

async function testSecondAdapterCallStopsTheFirst() {
  console.log('\nTest: a second enableVueRouterNavigation call stops the first — only the second records')
  const routerA = makeRouter()
  await routerA.push('/orders/1/items')
  await routerA.isReady()
  const stopA = enableVueRouterNavigation(routerA)

  const routerB = makeRouter()
  await routerB.push('/')
  await routerB.isReady()
  const stopB = enableVueRouterNavigation(routerB)

  const before = crumbCount()
  await routerA.push('/orders/2/items')
  assert('the stopped (first) adapter no longer records', crumbCount() === before, `got ${crumbCount() - before}`)

  await routerB.push('/orders/3/items')
  assert('the active (second) adapter still records', crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert('the recorded route is from the second router', getCurrentRoute()?.path === '/orders/3/items', JSON.stringify(getCurrentRoute()))

  void stopA
  stopB()
}

async function testAdapterWinsOverEnableNavigation() {
  console.log('\nTest: an adapter wins over enableNavigation() — one warning, and the history wrapper stops recording')
  enableNavigation()
  history.pushState({}, '', '/before-adapter')
  assert('enableNavigation recorded before any adapter', getCurrentRoute()?.path === '/before-adapter', JSON.stringify(getCurrentRoute()))

  const router = makeRouter()
  await router.push('/orders/5/items')
  await router.isReady()

  let stop: (() => void) | undefined
  const warnings = await captureWarningsAsync(async () => {
    stop = enableVueRouterNavigation(router)
  })
  assert('one warning that the adapter wins', warnings.filter((w) => w.includes('adapter wins')).length === 1, JSON.stringify(warnings))

  const before = crumbCount()
  history.pushState({}, '', '/ignored-by-history')
  assert('history.pushState no longer records once the adapter is active', crumbCount() === before, `got ${crumbCount() - before}`)

  await router.push('/orders/6/items')
  assert('exactly one crumb for the router navigation', crumbCount() === before + 1, `got ${crumbCount() - before}`)
  assert('the recorded route is the router\'s, not history\'s', getCurrentRoute()?.path === '/orders/6/items', JSON.stringify(getCurrentRoute()))

  stop?.()
}

async function testStopGivesNoMoreCrumbs() {
  console.log('\nTest: stop() -> no more crumbs')
  const router = makeRouter()
  await router.push('/orders/1/items')
  await router.isReady()
  const stop = enableVueRouterNavigation(router)

  const before = crumbCount()
  stop()
  await router.push('/orders/2/items')
  assert('no crumb was added after stop()', crumbCount() === before, `got ${crumbCount() - before}`)
}

async function run() {
  await testFirstRealMatchGivesOneCrumbWithTheRightLabels()
  await testNestedRouteWalksUpToTheDeepestNamedAncestor()
  await testNestedRouteWithNoNameAnywhereFallsBackToTheRoute()
  await testGuardReturningFalseGivesNoCrumb()
  await testQueryAndHashNeverAppearInAnyLabel()
  await testAdjustMasksAnEmail()
  await testThrowingAdjustWarnsOnceAndKeepsTheRoutersLabels()
  await testSecondAdapterCallStopsTheFirst()
  await testAdapterWinsOverEnableNavigation()
  await testStopGivesNoMoreCrumbs()
  reportResults()
}

run()
