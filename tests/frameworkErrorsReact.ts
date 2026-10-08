/**
 * Errors React and React Router catch (#69), through real data routers rendered by React 19
 * in jsdom, under both React Router majors.
 *
 * Every error must have exactly one way in: a render error reaches only `onCaughtError`, a
 * loader error only `router.state.errors`, and an error no boundary catches only `window`.
 * `setupGlobalErrorHandler()` stays on for the whole run, so a second way in shows up as a
 * second entry.
 *
 * jsdom is set up here, not through tests/browserStubs.ts, which defines its own window.
 *
 * Run: npx tsx tests/frameworkErrorsReact.ts
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
  sessionStorage: dom.window.sessionStorage,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

interface RootOptionsLike {
  onCaughtError?: (error: unknown, errorInfo: { componentStack?: string; errorBoundary?: unknown }) => void
}

interface RootLike {
  render: (element: unknown) => void
  unmount: () => void
}

interface ReactLike {
  createElement: (type: unknown, props?: unknown) => unknown
  act: (callback: () => Promise<void> | void) => Promise<void>
}

interface DataRouter {
  subscribe: Parameters<typeof import('../src/client/navigation/react-router.js').enableReactRouterNavigation>[0]['subscribe']
  state: Parameters<typeof import('../src/client/navigation/react-router.js').enableReactRouterNavigation>[0]['state']
  navigate(to: string): Promise<void>
}

interface RouterModule {
  createMemoryRouter: (routes: unknown[], opts: { initialEntries: string[] }) => DataRouter
  RouterProvider: unknown
  redirect: (to: string) => Response
}

const REACT = 'react'
const REACT_DOM_CLIENT = 'react-dom/client'

let React: ReactLike
let createRoot: (container: unknown, options?: RootOptionsLike) => RootLike
let enableReactRouterNavigation: typeof import('../src/client/navigation/react-router.js').enableReactRouterNavigation
let handleReactError: typeof import('../src/client/errorHandler.js').handleReactError
let capture: import('../src/testing.js').Capture
let resetSession: typeof import('../src/testing.js').resetSession

async function loadModulesAfterGlobals(): Promise<void> {
  React = (await import(REACT)) as ReactLike
  createRoot = ((await import(REACT_DOM_CLIENT)) as { createRoot: typeof createRoot }).createRoot
  enableReactRouterNavigation = (await import('../src/client/navigation/react-router.js')).enableReactRouterNavigation
  const errorHandler = await import('../src/client/errorHandler.js')
  handleReactError = errorHandler.handleReactError
  const testing = await import('../src/testing.js')
  resetSession = testing.resetSession
  capture = testing.captureEntries()
  const { initLogger } = await import('../src/client/logger.js')
  initLogger({ appId: 'acme', releaseId: 'test', logFunction: capture.logFunction })
  errorHandler.setupGlobalErrorHandler()
}

async function silencingConsoleError<T>(run: () => Promise<T>): Promise<T> {
  const real = console.error
  console.error = () => {}
  try {
    return await run()
  } finally {
    console.error = real
  }
}

async function flushEntries(): Promise<void> {
  await React.act(async () => {})
  await capture.settled()
}

function resetEntries(): void {
  resetSession()
  capture.clear()
}

function throwingComponent(): never {
  throw new Error('render exploded')
}

async function testRenderErrorReachesOnlyOnCaughtError(label: string, major: RouterModule) {
  console.log(`\nTest: a route that throws during render, onCaughtError: handleReactError (${label})`)
  resetEntries()
  const router = major.createMemoryRouter(
    [
      { path: '/', element: React.createElement('main'), handle: { screen: 'Home' } },
      { path: '/crash', element: React.createElement(throwingComponent), handle: { screen: 'Crash' } },
    ],
    { initialEntries: ['/'] },
  )
  const stop = enableReactRouterNavigation(router)
  const options: RootOptionsLike = { onCaughtError: handleReactError }
  const container = dom.window.document.createElement('div')
  const root = createRoot(container, options)
  await silencingConsoleError(async () => {
    await React.act(async () => root.render(React.createElement(major.RouterProvider, { router })))
    await React.act(async () => router.navigate('/crash'))
    await flushEntries()
  })

  assert('exactly one entry', capture.entries.length === 1, String(capture.entries.length))
  const entry = capture.entries[0]
  assert('it is an ERROR', entry?.severity === 'ERROR', entry?.severity)
  assert('errorType is ReactError', entry?.labels.errorType === 'ReactError', entry?.labels.errorType)
  assert('the message is the error message', entry?.message === 'render exploded', entry?.message)
  const componentStack = (entry?.jsonPayload?.context as { componentStack?: string } | undefined)?.componentStack
  assert('it carries a componentStack', typeof componentStack === 'string' && componentStack.length > 0, String(componentStack))
  assert('it carries the page labels', entry?.labels.route === '/crash' && entry?.labels.screen === 'Crash' && entry?.labels.path === '/crash', JSON.stringify(entry?.labels))

  await React.act(async () => root.unmount())
  stop()
}

async function testUncaughtRenderErrorReachesWindowOnce() {
  console.log('\nTest: no router, no boundary, a component that throws -> one ERROR from window')
  resetEntries()
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: false, configurable: true, writable: true })
  const container = dom.window.document.createElement('div')
  const root = createRoot(container)
  await silencingConsoleError(async () => {
    root.render(React.createElement(throwingComponent))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await capture.settled()
  })

  assert('exactly one entry', capture.entries.length === 1, String(capture.entries.length))
  assert('it is an ERROR with errorType UncaughtError', capture.entries[0]?.severity === 'ERROR' && capture.entries[0]?.labels.errorType === 'UncaughtError', JSON.stringify(capture.entries[0]?.labels))
  root.unmount()
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true })
}

function loaderRoutes(major: RouterModule): unknown[] {
  const main = React.createElement('main')
  return [
    { path: '/', element: main, handle: { screen: 'Home' } },
    { path: '/fails', element: main, handle: { screen: 'Fails' }, loader: () => { throw new Error('loader exploded') } },
    { path: '/missing', element: main, handle: { screen: 'Missing' }, loader: () => { throw new Response('nope', { status: 404, statusText: 'Not Found' }) } },
    { path: '/down', element: main, handle: { screen: 'Down' }, loader: () => { throw new Response('bad', { status: 503 }) } },
    { path: '/moved', element: main, handle: { screen: 'Moved' }, loader: () => major.redirect('/') },
  ]
}

async function testLoaderErrors(label: string, major: RouterModule) {
  console.log(`\nTest: loader errors reach the log once, at the right severity (${label})`)
  resetEntries()
  const router = major.createMemoryRouter(loaderRoutes(major), { initialEntries: ['/'] })
  const stop = enableReactRouterNavigation(router)
  const container = dom.window.document.createElement('div')
  const root = createRoot(container)
  await silencingConsoleError(async () => {
    await React.act(async () => root.render(React.createElement(major.RouterProvider, { router })))

    await React.act(async () => router.navigate('/fails'))
    await flushEntries()
    assert('a loader that throws -> one entry', capture.entries.length === 1, String(capture.entries.length))
    const failure = capture.entries[0]
    assert('it is an ERROR with errorType RouteError', failure?.severity === 'ERROR' && failure?.labels.errorType === 'RouteError', JSON.stringify(failure?.labels))
    assert('the message is the error message', failure?.message === 'loader exploded', failure?.message)
    assert('it carries the failing page labels', failure?.labels.route === '/fails' && failure?.labels.screen === 'Fails', JSON.stringify(failure?.labels))

    await React.act(async () => router.navigate('/missing'))
    await flushEntries()
    assert('a loader that throws a 404 -> one more entry, the first error is not logged again', capture.entries.length === 2, String(capture.entries.length))
    const missing = capture.entries[1]
    assert('the 404 is a WARNING with errorType RouteError', missing?.severity === 'WARNING' && missing?.labels.errorType === 'RouteError', JSON.stringify(missing))
    assert('the 404 carries its page labels', missing?.labels.route === '/missing' && missing?.labels.screen === 'Missing', JSON.stringify(missing?.labels))

    await React.act(async () => router.navigate('/down'))
    await flushEntries()
    assert('a loader that throws a 503 -> an ERROR', capture.entries.length === 3 && capture.entries[2]?.severity === 'ERROR', JSON.stringify(capture.entries[2]?.severity))

    await React.act(async () => router.navigate('/moved'))
    await flushEntries()
    assert('a loader that returns redirect() -> no entry', capture.entries.length === 3, String(capture.entries.length))
    assert('the redirect ended on /', router.state.location.pathname === '/', router.state.location.pathname)
  })
  await React.act(async () => root.unmount())
  stop()
}

async function testCallingTheAdapterAgainLogsOnce(label: string, major: RouterModule) {
  console.log(`\nTest: calling the adapter again stops the first one's error listener (${label})`)
  resetEntries()
  const router = major.createMemoryRouter(loaderRoutes(major), { initialEntries: ['/'] })
  enableReactRouterNavigation(router)
  const stop = enableReactRouterNavigation(router)
  await silencingConsoleError(async () => {
    await router.navigate('/fails')
    await flushEntries()
  })
  assert('one loader error -> exactly one entry', capture.entries.length === 1, String(capture.entries.length))
  stop()
}

async function testAStoppedAdapterLogsNothing(label: string, major: RouterModule) {
  console.log(`\nTest: the stop function takes the error listener with it (${label})`)
  resetEntries()
  const router = major.createMemoryRouter(loaderRoutes(major), { initialEntries: ['/'] })
  const stop = enableReactRouterNavigation(router)
  stop()
  await silencingConsoleError(async () => {
    await router.navigate('/fails')
    await flushEntries()
  })
  assert('a loader error after stop() -> no entry', capture.entries.length === 0, String(capture.entries.length))
}

async function main(): Promise<void> {
  await loadModulesAfterGlobals()
  await testUncaughtRenderErrorReachesWindowOnce()
  for (const [label, pkg] of [['react-router 6', 'react-router-6'], ['react-router 7', 'react-router-7']] as const) {
    const major = (await import(pkg)) as RouterModule
    await testRenderErrorReachesOnlyOnCaughtError(label, major)
    await testLoaderErrors(label, major)
    await testCallingTheAdapterAgainLogsOnce(label, major)
    await testAStoppedAdapterLogsNothing(label, major)
  }
  reportResults()
}

main()
