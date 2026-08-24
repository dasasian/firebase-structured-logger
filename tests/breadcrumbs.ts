/**
 * Breadcrumb trail unit tests.
 *
 * Run: npx tsx tests/breadcrumbs.ts
 */

import {
  addBreadcrumb,
  getLastBreadcrumbs,
  clearBreadcrumbs,
  setCurrentScreen,
  getCurrentScreen,
  bc,
} from '../src/client/breadcrumbs.js'
import { assert, reportResults } from './testHelpers.js'
import { withFrozenTime } from './browserStubs.js'

const MAX_BREADCRUMBS = 50
const MAX_AGE_MS = 5 * 60 * 1000

// --- Recording ---

function testAddBreadcrumb() {
  console.log('\nTest: addBreadcrumb records type, name and data')
  clearBreadcrumbs()

  addBreadcrumb('action', 'open_product_entry', { locationId: 'loc_123' })

  const [entry] = getLastBreadcrumbs(10)
  assert('one breadcrumb was recorded', getLastBreadcrumbs(10).length === 1)
  assert('type is kept', entry.type === 'action')
  assert('name is kept', entry.name === 'open_product_entry')
  assert('data is kept', (entry.data as { locationId: string })?.locationId === 'loc_123')
  assert('a timestamp is stamped on', typeof entry.timestamp === 'number' && entry.timestamp > 0)
}

function testOrderIsOldestFirst() {
  console.log('\nTest: breadcrumbs come back oldest first')
  clearBreadcrumbs()

  addBreadcrumb('action', 'first')
  addBreadcrumb('action', 'second')
  addBreadcrumb('action', 'third')

  const names = getLastBreadcrumbs(10).map((entry) => entry.name)
  assert('order is preserved', names.join(',') === 'first,second,third', `got: ${names.join(',')}`)
}

function testGetLastBreadcrumbsCount() {
  console.log('\nTest: getLastBreadcrumbs returns the most recent N')
  clearBreadcrumbs()

  for (let i = 1; i <= 5; i++) addBreadcrumb('action', `step_${i}`)

  const lastTwo = getLastBreadcrumbs(2).map((entry) => entry.name)
  assert('exactly two came back', lastTwo.length === 2)
  assert('they are the newest two', lastTwo.join(',') === 'step_4,step_5', `got: ${lastTwo.join(',')}`)

  assert('asking for more than exist returns all', getLastBreadcrumbs(100).length === 5)
  assert('asking for zero returns none', getLastBreadcrumbs(0).length === 0)
}

// --- Trimming ---

function testCapAtFifty() {
  console.log('\nTest: the trail is capped at 50 entries')
  clearBreadcrumbs()

  for (let i = 1; i <= 60; i++) addBreadcrumb('action', `step_${i}`)

  const all = getLastBreadcrumbs(1000)
  assert('the trail is capped', all.length === MAX_BREADCRUMBS, `got: ${all.length}`)
  assert('the oldest were dropped', all[0].name === 'step_11', `got: ${all[0].name}`)
  assert('the newest was kept', all[all.length - 1].name === 'step_60')
}

function testAgeExpiry() {
  console.log('\nTest: entries older than 5 minutes are dropped')
  clearBreadcrumbs()

  const start = 1_000_000_000_000

  withFrozenTime(start, () => addBreadcrumb('action', 'ancient'))
  withFrozenTime(start + 60_000, () => addBreadcrumb('action', 'recent'))

  // Read inside the frozen window. The cutoff is relative to Date.now(), so a
  // read at the real clock would find every fixture entry decades expired.
  assert('both are present before anything expires',
    withFrozenTime(start + 60_000, () => getLastBreadcrumbs(10)).length === 2)

  // Now add one far enough ahead that 'ancient' is past the cutoff but
  // 'recent' is not.
  withFrozenTime(start + MAX_AGE_MS + 1, () => addBreadcrumb('action', 'newest'))

  const names = withFrozenTime(start + MAX_AGE_MS + 1, () =>
    getLastBreadcrumbs(10).map((entry) => entry.name))
  assert('the expired entry was dropped', !names.includes('ancient'), `got: ${names.join(',')}`)
  assert('the still-fresh entry survived', names.includes('recent'), `got: ${names.join(',')}`)
  assert('the new entry is there', names.includes('newest'))
  assert('exactly two remain', names.length === 2, `got: ${names.join(',')}`)
}

function testExpiryAppliesOnReadNotOnlyOnWrite() {
  console.log('\nTest: the cutoff applies when reading, not only when writing')

  // Expiring only on write means the age cap lapses exactly when nothing is
  // happening. A user does a few things, goes idle for ten minutes, comes back
  // and hits an error: with a write-only cutoff that error ships a trail of
  // ten-minute-old steps presented as the path that led to it. No write ever
  // came to clear them.
  clearBreadcrumbs()
  const start = 4_000_000_000_000

  withFrozenTime(start, () => addBreadcrumb('action', 'before_the_pause'))

  const afterIdle = withFrozenTime(start + 10 * 60 * 1000, () => getLastBreadcrumbs(50))
  assert('a stale trail is not returned to a reader', afterIdle.length === 0,
    `got: ${afterIdle.map((e) => e.name).join(',')}`)

  // And a read within the window still returns it — the cutoff, not a reset.
  clearBreadcrumbs()
  withFrozenTime(start, () => addBreadcrumb('action', 'recent_enough'))
  const withinWindow = withFrozenTime(start + 60_000, () => getLastBreadcrumbs(50))
  assert('a fresh trail is untouched', withinWindow.length === 1,
    `got: ${withinWindow.length}`)
}

function testNothingExpiresWhenAllAreFresh() {
  console.log('\nTest: nothing is dropped while every entry is fresh')
  clearBreadcrumbs()

  const start = 2_000_000_000_000
  withFrozenTime(start, () => addBreadcrumb('action', 'a'))
  withFrozenTime(start + 1_000, () => addBreadcrumb('action', 'b'))
  withFrozenTime(start + 2_000, () => addBreadcrumb('action', 'c'))

  const names = withFrozenTime(start + 2_000, () =>
    getLastBreadcrumbs(10).map((entry) => entry.name))
  assert('all three survive', names.join(',') === 'a,b,c', `got: ${names.join(',')}`)
}

function testEverythingCanExpire() {
  console.log('\nTest: a long gap clears the whole trail')
  clearBreadcrumbs()

  const start = 3_000_000_000_000
  withFrozenTime(start, () => addBreadcrumb('action', 'old_a'))
  withFrozenTime(start + 1_000, () => addBreadcrumb('action', 'old_b'))

  const at = start + MAX_AGE_MS + 10_000
  withFrozenTime(at, () => addBreadcrumb('action', 'fresh'))

  const names = withFrozenTime(at, () => getLastBreadcrumbs(10).map((entry) => entry.name))
  assert('only the new entry remains', names.join(',') === 'fresh', `got: ${names.join(',')}`)
}

// --- Screen ---

function testScreenTracking() {
  console.log('\nTest: setCurrentScreen tracks the screen and leaves a breadcrumb')
  clearBreadcrumbs()

  setCurrentScreen('ProductEntryModal')

  assert('the current screen is readable', getCurrentScreen() === 'ProductEntryModal')

  const [entry] = getLastBreadcrumbs(10)
  assert('a nav breadcrumb was added', entry.type === 'nav')
  assert('it names the screen', entry.name === 'navigate_ProductEntryModal', `got: ${entry.name}`)
}

function testClearResetsEverything() {
  console.log('\nTest: clearBreadcrumbs resets the trail and the screen')
  addBreadcrumb('action', 'something')
  setCurrentScreen('Checkout')

  clearBreadcrumbs()

  assert('the trail is empty', getLastBreadcrumbs(10).length === 0)
  assert('the screen is cleared', getCurrentScreen() === undefined)
}

// --- Shorthand helpers ---

function testShorthandHelpers() {
  console.log('\nTest: the bc shorthand helpers')
  clearBreadcrumbs()

  bc.action('tapped_save', { id: 1 })
  bc.state('cart_updated')
  bc.error('ValidationError', { field: 'price' })
  bc.nav('Settings')

  const entries = getLastBreadcrumbs(10)
  assert('four breadcrumbs were recorded', entries.length === 4, `got: ${entries.length}`)
  assert('bc.action records an action', entries[0].type === 'action' && entries[0].name === 'tapped_save')
  assert('bc.action keeps data', (entries[0].data as { id: number })?.id === 1)
  assert('bc.state records a state change', entries[1].type === 'state' && entries[1].name === 'cart_updated')
  assert('bc.error records an error', entries[2].type === 'error' && entries[2].name === 'ValidationError')
  assert('bc.nav records a nav entry', entries[3].type === 'nav' && entries[3].name === 'navigate_Settings')
  assert('bc.nav also sets the screen', getCurrentScreen() === 'Settings')
}

// --- Runner ---

function run() {
  testAddBreadcrumb()
  testOrderIsOldestFirst()
  testGetLastBreadcrumbsCount()
  testCapAtFifty()
  testAgeExpiry()
  testExpiryAppliesOnReadNotOnlyOnWrite()
  testNothingExpiresWhenAllAreFresh()
  testEverythingCanExpire()
  testScreenTracking()
  testClearResetsEverything()
  testShorthandHelpers()

  reportResults()
}

run()
