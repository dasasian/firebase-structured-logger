/**
 * The hooks that run inside a framework's or router's own error path must never throw,
 * even before `initLogger()` has run: they log nothing and say so once on the console.
 * This suite never calls `initLogger()`.
 *
 * Run: npx tsx tests/frameworkHooksWithoutLogger.ts
 */

import '../tests/browserStubs.js'
import { createMemoryRouter } from 'react-router-7'
import { createRouter, createMemoryHistory } from 'vue-router'
import { assert, reportResults } from './testHelpers.js'
import { handleReactError, handleVueError } from '../src/client/errorHandler.js'
import { enableReactRouterNavigation } from '../src/client/navigation/react-router.js'
import { enableVueRouterNavigation } from '../src/client/navigation/vue-router.js'

const warnings: string[] = []
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }

function throwsFrom(run: () => void): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function testReactRouterLoaderErrorWithNoLogger() {
  console.log('\nTest: a loader error with the adapter on and no logger -> navigate() resolves, state.errors has it')
  const router = createMemoryRouter(
    [
      { path: '/', element: null },
      { path: '/bad', element: null, loader: () => { throw new Error('loader exploded') } },
    ],
    { initialEntries: ['/'] },
  )
  const stop = enableReactRouterNavigation(router)
  let rejected: string | undefined
  await router.navigate('/bad').catch((error: unknown) => { rejected = String(error) })
  assert('navigate() resolved', rejected === undefined, rejected)
  assert('the router kept the error', router.state.errors !== null && Object.keys(router.state.errors).length === 1)
  stop()
}

async function testVueGuardErrorWithNoLogger() {
  console.log('\nTest: a guard that throws with the adapter on and no logger -> the rejection is the guard\'s own')
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: {} },
      { path: '/bad', component: {}, beforeEnter: () => { throw new Error('guard exploded') } },
    ],
  })
  const stop = enableVueRouterNavigation(router)
  await router.push('/')
  let rejected: string | undefined
  await router.push('/bad').catch((error: Error) => { rejected = error.message })
  assert('push() rejected with the guard\'s error, not fsl\'s', rejected === 'guard exploded', rejected)
  stop()
}

function testHandlersWithNoLogger() {
  console.log('\nTest: handleReactError and handleVueError with no logger do not throw')
  assert('handleReactError', throwsFrom(() => handleReactError(new Error('x'), { componentStack: '\n at A' })) === undefined)
  assert('handleVueError', throwsFrom(() => handleVueError(new Error('x'), {}, 'render function')) === undefined)
}

async function main() {
  await testReactRouterLoaderErrorWithNoLogger()
  await testVueGuardErrorWithNoLogger()
  testHandlersWithNoLogger()
  console.log('\nTest: exactly one warning, naming initLogger()')
  assert('one warning', warnings.length === 1, warnings.join(' | '))
  assert('it names initLogger()', warnings[0]?.includes('initLogger()') === true, warnings[0])
  reportResults()
}

main()
