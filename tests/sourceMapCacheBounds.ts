/**
 * The Storage source-map cache is bounded (#18).
 *
 * It grows with releases x bundles and lives for the instance's lifetime. A
 * real Vite map is ~580KB after `sourcesContent` is stripped, and maps uploaded
 * before 0.4.0 still carry theirs at ~2.2MB. Unbounded, that is a plausible
 * out-of-memory on a 256MB Cloud Function — presenting as random instance
 * crashes rather than a logging fault.
 *
 * These drive the cache through the exported helpers rather than a live bucket,
 * so no cloud is involved.
 *
 * Run: npx tsx tests/sourceMapCacheBounds.ts
 */

import { __cacheForTests as c } from '../src/functions/sourceMapCache.js'
import { assert, reportResults } from './testHelpers.js'

const MB = 1024 * 1024
const mapOf = (id: string) => ({ version: 3 as const, sources: [id], names: [], mappings: 'AAAA' })

function reset(): void {
  c.clear()
}

function testStaysUnderTheBudget() {
  console.log('\nTest: the cache stays under its byte budget')
  reset()
  const limit = c.stats().limit

  // 200 maps at 580KB — roughly 116MB, comfortably over a 64MB budget.
  for (let i = 0; i < 200; i++) c.set(`k${i}`, mapOf(`m${i}`), 580 * 1024)

  const { bytes, entries } = c.stats()
  assert('bytes are within the budget', bytes <= limit, `${Math.round(bytes / MB)}MB vs ${Math.round(limit / MB)}MB`)
  assert('entries were evicted', entries < 200, `kept all ${entries}`)
  console.log(`    kept ${entries}/200 maps, ${Math.round(bytes / MB)}MB of a ${Math.round(limit / MB)}MB budget`)
}

function testEvictsOldestFirst() {
  console.log('\nTest: eviction is oldest-first')
  reset()
  for (let i = 0; i < 200; i++) c.set(`k${i}`, mapOf(`m${i}`), 580 * 1024)

  assert('the first inserted is gone', c.get('k0') === undefined)
  assert('the most recent survives', c.get('k199') !== undefined)
}

function testRecentlyUsedSurvives() {
  console.log('\nTest: a re-read entry outlives an older one — LRU, not FIFO')
  reset()

  // Big entries so the capacity is small and the comparison is unambiguous:
  // 8MB each into a 64MB budget means 8 fit. With 140 insertions and 112 slots
  // any entry is evicted eventually, so a fair test evicts only a few.
  const BIG = 8 * MB
  for (let i = 0; i < 8; i++) c.set(`k${i}`, mapOf(`m${i}`), BIG)
  assert('the cache is full at 8', c.stats().entries === 8, `got ${c.stats().entries}`)

  // Touch the oldest. Under FIFO it is next out; under LRU it is now newest.
  assert('k0 is present before touching', c.get('k0') !== undefined)

  // Two more entries force exactly two evictions.
  c.set('new1', mapOf('n1'), BIG)
  c.set('new2', mapOf('n2'), BIG)

  assert('the touched entry survived', c.get('k0') !== undefined, 'FIFO would have dropped it first')
  assert('the untouched older entries went instead', c.get('k1') === undefined && c.get('k2') === undefined)
  assert('the new entries are present', c.get('new1') !== undefined && c.get('new2') !== undefined)
}

function testNegativeEntriesAreExemptAndSurvive() {
  console.log('\nTest: negative entries cost nothing and are not evicted')
  reset()

  // A confirmed miss. Each one prevents a repeated Storage round-trip, which
  // matters more since a release mismatch now consults Storage first.
  c.set('missing-map', null, 0)
  const afterMiss = c.stats().bytes
  assert('a negative entry adds no bytes', afterMiss === 0, `${afterMiss} bytes`)

  // Flood past the budget with real maps.
  for (let i = 0; i < 200; i++) c.set(`k${i}`, mapOf(`m${i}`), 580 * 1024)

  const hit = c.get('missing-map')
  assert('the negative entry survived eviction', hit !== undefined, 'it would cost a Storage round-trip per error')
  assert('and still means "not found"', hit?.map === null)
}

function testReplacingAnEntryDoesNotDoubleCount() {
  console.log('\nTest: replacing an entry does not double-count its bytes')
  reset()
  c.set('same', mapOf('a'), 10 * MB)
  const first = c.stats().bytes
  c.set('same', mapOf('b'), 10 * MB)
  const second = c.stats().bytes

  assert('bytes are unchanged after replacing', first === second, `${first} then ${second}`)
  assert('there is still one entry', c.stats().entries === 1)
}

function testClearResetsAccounting() {
  console.log('\nTest: clearing resets the byte count, not just the entries')
  reset()
  for (let i = 0; i < 20; i++) c.set(`k${i}`, mapOf(`m${i}`), 580 * 1024)
  assert('bytes were counted', c.stats().bytes > 0)

  c.clear()
  assert('entries cleared', c.stats().entries === 0)
  assert('bytes reset — otherwise the budget leaks across clears', c.stats().bytes === 0, `${c.stats().bytes}`)
}

function run() {
  testStaysUnderTheBudget()
  testEvictsOldestFirst()
  testRecentlyUsedSurvives()
  testNegativeEntriesAreExemptAndSurvive()
  testReplacingAnEntryDoesNotDoubleCount()
  testClearResetsAccounting()
  reportResults()
}

run()
