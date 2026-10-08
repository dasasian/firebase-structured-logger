/**
 * A `<Navigate>` element records two nav breadcrumbs, the page that rendered it and the
 * page it ends on. Only a loader `redirect()` collapses to one (tests/reactRouterNavigation.ts).
 * This renders a real RouterProvider in jsdom under both React Router majors.
 *
 * jsdom is set up here, not through tests/browserStubs.ts, which defines its own window.
 *
 * Run: npx tsx tests/reactRouterNavigateElement.ts
 */

import { JSDOM } from 'jsdom'
import { assert, reportResults } from './testHelpers.js'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://app.example.com/old',
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

interface ReactLike {
  createElement: (type: unknown, props?: unknown) => unknown
  act: (callback: () => Promise<void> | void) => Promise<void>
}

interface RootLike {
  render: (element: unknown) => void
  unmount: () => void
}

const REACT = 'react'
const REACT_DOM_CLIENT = 'react-dom/client'

let React: ReactLike
let createRoot: (container: unknown) => RootLike
let enableReactRouterNavigation: typeof import('../src/client/navigation/react-router.js').enableReactRouterNavigation
let getLastBreadcrumbs: typeof import('../src/client/breadcrumbs.js').getLastBreadcrumbs
let resetSession: typeof import('../src/testing.js').resetSession

async function loadModulesAfterGlobals(): Promise<void> {
  React = (await import(REACT)) as ReactLike
  createRoot = ((await import(REACT_DOM_CLIENT)) as { createRoot: typeof createRoot }).createRoot
  enableReactRouterNavigation = (await import('../src/client/navigation/react-router.js')).enableReactRouterNavigation
  getLastBreadcrumbs = (await import('../src/client/breadcrumbs.js')).getLastBreadcrumbs
  resetSession = (await import('../src/testing.js')).resetSession
}

interface RouterModule {
  createMemoryRouter: (routes: unknown[], opts: { initialEntries: string[] }) => Parameters<typeof enableReactRouterNavigation>[0]
  RouterProvider: unknown
  Navigate: unknown
}

async function navCrumbNamesAfterRenderingOld(label: string, pkg: string): Promise<string[]> {
  const { createMemoryRouter, RouterProvider, Navigate } = (await import(pkg)) as RouterModule
  const { act } = React
  resetSession()
  const router = createMemoryRouter(
    [
      { path: '/old', element: React.createElement(Navigate as never, { to: '/new', replace: true }), handle: { screen: 'Old' } },
      { path: '/new', element: React.createElement('main'), handle: { screen: 'New' } },
    ],
    { initialEntries: ['/old'] },
  )
  const stop = enableReactRouterNavigation(router)
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(RouterProvider as never, { router }))
  })
  await act(async () => {})
  const names = getLastBreadcrumbs(100).filter((b) => b.type === 'nav').map((b) => b.name)
  await act(async () => root.unmount())
  stop()
  return names
}

async function main(): Promise<void> {
  await loadModulesAfterGlobals()
  for (const [label, pkg] of [['react-router 6', 'react-router-6'], ['react-router 7', 'react-router-7']] as const) {
    console.log(`\nTest: <Navigate> records Old then New (${label})`)
    const names = await navCrumbNamesAfterRenderingOld(label, pkg)
    assert(`[${label}] exactly two nav crumbs, Old then New`, names.length === 2 && names[0] === 'Old' && names[1] === 'New', names.join(', '))
  }
  reportResults()
}

main()
