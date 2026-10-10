/**
 * Public API surface test.
 *
 * The exported names of each entry point are the package's contract. This file
 * pins them so that adding or removing one shows up as a deliberate diff rather
 * than drift nobody reviews.
 *
 * `Logger` deliberately does NOT appear in the client's runtime exports: the
 * client logger is a session singleton (see the note in src/client/index.ts),
 * so a constructible class would advertise independence it does not have. It is
 * still exported as a *type* for annotations.
 *
 * If you are here because this test failed: decide whether the change is
 * intended, then update the list.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/publicApi.ts
 */

import { spawnSync } from 'child_process'
import * as path from 'path'
import { assert, reportResults } from './testHelpers.js'
import * as client from '../src/client/index.js'
import * as functions from '../src/functions/index.js'
import * as vueRouterNavigation from '../src/client/navigation/vue-router.js'
import * as reactRouterNavigation from '../src/client/navigation/react-router.js'
import * as views from '../src/client/views.js'
import * as actions from '../src/client/actions.js'
import * as testing from '../src/testing.js'
import type { Logger } from '../src/client/logger.js'

const EXPECTED: Record<string, string[]> = {
  client: [
    'addBreadcrumb',
    'bc',
    'getClientLogger',
    'handleReactError',
    'handleVueError',
    'initLogger',
    'sendFeedback',
    'sendTestLog',
    'setupGlobalErrorHandler',
    'triggerTestLog',
  ],
  functions: [
    'createClientLogFunction',
    'createClientLogHandler',
    'getLogger',
    'initLogger',
    'logDebug',
    'logError',
    'logInfo',
    'logWarn',
    'ClientLogError',
    'configureAttachments',
    'createHttpLogHandler',
    'withLogging',
    'trace',
    'startTrace',
    'configureTraces',
  ],
  'client/navigation/vue-router': ['enableVueRouterNavigation'],
  'client/navigation/react-router': ['enableReactRouterNavigation'],
  'client/views': ['enableViews'],
  'client/actions': ['enableActions'],
  testing: ['captureEntries', 'resetSession'],
}

function checkSurface(name: string, mod: object) {
  console.log(`\nTest: ${name} entry point exports exactly what it promises`)
  const actual = Object.keys(mod).sort()
  const expected = EXPECTED[name]

  const added = actual.filter((k) => !expected.includes(k))
  const removed = expected.filter((k) => !actual.includes(k))

  assert(`${name}: nothing unexpectedly added`, added.length === 0, `new exports: ${added.join(', ')}`)
  assert(`${name}: nothing unexpectedly removed`, removed.length === 0, `missing exports: ${removed.join(', ')}`)
}

function testClientLoggerIsNotConstructible() {
  console.log('\nTest: Logger is not exported as a constructible value')
  assert(
    'client does not export Logger at runtime',
    !('Logger' in client),
    'Logger is a session singleton — exporting the class advertises independence it does not have',
  )
}

const CLIENT_LOGGER_MEMBERS_PINNED_BY_TYPECHECK: Record<keyof Logger, true> = {
  setUser: true,
  clearUser: true,
  setScreen: true,
  addBreadcrumb: true,
  error: true,
  warning: true,
  info: true,
  debug: true,
  sendFeedback: true,
}

function testDoctorCommandSurface() {
  console.log('\nTest: fsl doctor is listed with its documented flags')
  const cli = path.join(process.cwd(), 'src', 'tools', 'index.ts')
  const out = spawnSync('npx', ['tsx', cli], { encoding: 'utf-8' })
  const help = out.stdout
  assert('help lists fsl doctor', help.includes('fsl doctor'), help)
  for (const flag of ['--backend=<path>', '--dist=<path>', '--strict', '--json']) {
    assert(`help documents ${flag}`, help.includes(flag), help)
  }
}

function testNoEntryPointExportsSetSendWatcher() {
  console.log('\nTest: no entry point exports setSendWatcher')
  const modules: Record<string, object> = {
    client,
    functions,
    'client/navigation/vue-router': vueRouterNavigation,
    'client/navigation/react-router': reactRouterNavigation,
    'client/views': views,
    'client/actions': actions,
    testing,
  }
  for (const [name, mod] of Object.entries(modules)) {
    assert(`${name} does not export setSendWatcher`, !('setSendWatcher' in mod))
  }
}

function run() {
  checkSurface('client', client)
  checkSurface('functions', functions)
  checkSurface('client/navigation/vue-router', vueRouterNavigation)
  checkSurface('client/navigation/react-router', reactRouterNavigation)
  checkSurface('client/views', views)
  checkSurface('client/actions', actions)
  checkSurface('testing', testing)
  testNoEntryPointExportsSetSendWatcher()
  testClientLoggerIsNotConstructible()
  testDoctorCommandSurface()
  reportResults()
}

run()
