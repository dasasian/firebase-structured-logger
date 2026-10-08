/**
 * Errors Vue and Vue Router catch (#69): a component error reaches only
 * `app.config.errorHandler`, a guard or lazy-route failure only `router.onError`.
 * `setupGlobalErrorHandler()` stays on for the whole run, so a second way in shows up as a
 * second entry.
 *
 * jsdom is set up here, not through tests/browserStubs.ts, which defines its own window.
 *
 * Run: npx tsx tests/frameworkErrorsVue.ts
 */

import { JSDOM } from 'jsdom'
import { assert, reportResults } from './testHelpers.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.com/',
  pretendToBeVisual: true,
})

for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  history: dom.window.history,
  location: dom.window.location,
  sessionStorage: dom.window.sessionStorage,
  localStorage: dom.window.localStorage,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

import type { App } from 'vue'
import type { Router } from 'vue-router'

let capture: import('../src/testing.js').Capture
let resetSession: typeof import('../src/testing.js').resetSession
let handleVueError: typeof import('../src/client/errorHandler.js').handleVueError
let enableVueRouterNavigation: typeof import('../src/client/navigation/vue-router.js').enableVueRouterNavigation
let createApp: typeof import('vue').createApp
let createRouter: typeof import('vue-router').createRouter
let createMemoryHistory: typeof import('vue-router').createMemoryHistory

async function loadModulesAfterGlobals(): Promise<void> {
  const vue = await import('vue')
  createApp = vue.createApp
  const vueRouter = await import('vue-router')
  createRouter = vueRouter.createRouter
  createMemoryHistory = vueRouter.createMemoryHistory
  const errorHandler = await import('../src/client/errorHandler.js')
  handleVueError = errorHandler.handleVueError
  enableVueRouterNavigation = (await import('../src/client/navigation/vue-router.js')).enableVueRouterNavigation
  const testing = await import('../src/testing.js')
  resetSession = testing.resetSession
  capture = testing.captureEntries()
  const { initLogger } = await import('../src/client/logger.js')
  initLogger({ appId: 'acme', releaseId: 'test', logFunction: capture.logFunction })
  errorHandler.setupGlobalErrorHandler()
}

function resetEntries(): void {
  resetSession()
  capture.clear()
}

async function silencingConsoleError<T>(run: () => Promise<T>): Promise<T> {
  const real = console.error
  const realWarn = console.warn
  console.error = () => {}
  console.warn = () => {}
  try {
    return await run()
  } finally {
    console.error = real
    console.warn = realWarn
  }
}

async function testComponentErrorReachesTheHandlerOnce() {
  console.log('\nTest: a component that throws, app.config.errorHandler = handleVueError -> one ERROR')
  resetEntries()
  const app: App = createApp({
    render() {
      throw new Error('component exploded')
    },
  })
  app.config.errorHandler = handleVueError
  await silencingConsoleError(async () => {
    try {
      app.mount(dom.window.document.createElement('div'))
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
    await capture.settled()
  })

  assert('exactly one entry', capture.entries.length === 1, String(capture.entries.length))
  const entry = capture.entries[0]
  assert('it is an ERROR with errorType VueError', entry?.severity === 'ERROR' && entry?.labels.errorType === 'VueError', JSON.stringify(entry?.labels))
  assert('the message is the error message', entry?.message === 'component exploded', entry?.message)
  const info = (entry?.jsonPayload?.context as { info?: string } | undefined)?.info
  assert('Vue\'s info is in context', typeof info === 'string' && info.length > 0, String(info))
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'Home', component: {} },
      { path: '/guarded', name: 'Guarded', component: {}, beforeEnter: () => { throw new Error('guard exploded') } },
      { path: '/lazy', name: 'Lazy', component: () => Promise.reject(new Error('chunk failed to load')) },
      { path: '/refused', name: 'Refused', component: {}, beforeEnter: () => false },
    ],
  })
}

async function pushIgnoringRejection(router: Router, to: string): Promise<void> {
  await router.push(to).catch(() => {})
}

async function testRouterErrors() {
  console.log('\nTest: a guard that throws and a lazy route that fails -> one RouteError ERROR each')
  resetEntries()
  const router = makeRouter()
  const stop = enableVueRouterNavigation(router)
  await router.push('/')
  await silencingConsoleError(async () => {
    await pushIgnoringRejection(router, '/guarded')
    await capture.settled()
  })
  assert('the guard -> one entry', capture.entries.length === 1, String(capture.entries.length))
  const guard = capture.entries[0]
  assert('it is an ERROR with errorType RouteError', guard?.severity === 'ERROR' && guard?.labels.errorType === 'RouteError', JSON.stringify(guard?.labels))
  assert('the message is the error message', guard?.message === 'guard exploded', guard?.message)
  assert('it carries the page the user is still on', guard?.labels.route === '/' && guard?.labels.screen === 'Home', JSON.stringify(guard?.labels))
  assert('the attempted path is in context', (guard?.jsonPayload?.context as { path?: string } | undefined)?.path === '/guarded', JSON.stringify(guard?.jsonPayload?.context))

  await silencingConsoleError(async () => {
    await pushIgnoringRejection(router, '/lazy')
    await capture.settled()
  })
  assert('the lazy route -> one more entry', capture.entries.length === 2 && capture.entries[1]?.message === 'chunk failed to load', capture.entries.map((e) => e.message).join(' | '))

  await pushIgnoringRejection(router, '/refused')
  await capture.settled()
  assert('a guard that refuses (returns false) is not an error -> no entry', capture.entries.length === 2, String(capture.entries.length))
  stop()
}

async function testCallingTheAdapterAgainLogsOnce() {
  console.log('\nTest: calling the adapter again stops the first one\'s error listener')
  resetEntries()
  const router = makeRouter()
  enableVueRouterNavigation(router)
  const stop = enableVueRouterNavigation(router)
  await router.push('/')
  await silencingConsoleError(async () => {
    await pushIgnoringRejection(router, '/guarded')
    await capture.settled()
  })
  assert('one guard error -> exactly one entry', capture.entries.length === 1, String(capture.entries.length))
  stop()
}

async function testAStoppedAdapterLogsNothing() {
  console.log('\nTest: the stop function takes the error listener with it')
  resetEntries()
  const router = makeRouter()
  const stop = enableVueRouterNavigation(router)
  stop()
  await silencingConsoleError(async () => {
    await pushIgnoringRejection(router, '/guarded')
    await capture.settled()
  })
  assert('a guard error after stop() -> no entry', capture.entries.length === 0, String(capture.entries.length))
}

async function main(): Promise<void> {
  await loadModulesAfterGlobals()
  await testComponentErrorReachesTheHandlerOnce()
  await testRouterErrors()
  await testCallingTheAdapterAgainLogsOnce()
  await testAStoppedAdapterLogsNothing()
  reportResults()
}

main()
