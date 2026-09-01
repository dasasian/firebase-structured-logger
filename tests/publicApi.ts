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

import { assert, reportResults } from './testHelpers.js'
import * as client from '../src/client/index.js'
import * as functions from '../src/functions/index.js'

const EXPECTED: Record<string, string[]> = {
  client: [
    'addBreadcrumb',
    'bc',
    'getClientLogger',
    'handleReactError',
    'initLogger',
    'sendFeedback',
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
    'configureAttachments',
    'withLogging',
  ],
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

function run() {
  checkSurface('client', client)
  checkSurface('functions', functions)
  testClientLoggerIsNotConstructible()
  reportResults()
}

run()
