/**
 * `sourcesContent` stripping on upload.
 *
 * Symbolication never reads `sourcesContent` — `originalPositionFor` needs only
 * `sources`, `names` and `mappings` — but bundlers emit it by default and it is
 * the bulk of a real map. Uploading it verbatim cost storage, download time on
 * the per-error path, and Cloud Function memory, for nothing.
 *
 * It is also the original source code, so uploading maps as-is meant a logging
 * tool quietly shipped source into a Storage bucket.
 *
 * Run: npx tsx tests/sourceMapStripping.ts
 */

import { stripSourcesContent } from '../src/tools/uploadSourceMaps.js'
import { symbolicate } from '../src/functions/symbolicate.js'
import type { EncodedSourceMap } from '@jridgewell/trace-mapping'
import { assert, reportResults } from './testHelpers.js'

// col 4 -> catalogProducts.ts:10:2 "duplicate"
const BASE: EncodedSourceMap = {
  version: 3,
  sources: ['../../src/services/catalogProducts.ts'],
  names: ['duplicate', 'handleCreate'],
  mappings: 'IASEA,cAeFC',
}

function testRemovesSourcesContent() {
  console.log('\nTest: sourcesContent is removed')
  const withContent = { ...BASE, sourcesContent: ['const secret = "my source code"'] }
  const { json, stripped } = stripSourcesContent(JSON.stringify(withContent))

  assert('it reports having stripped', stripped)
  assert('the key is gone', !('sourcesContent' in JSON.parse(json)))
  assert('the source text is gone', !json.includes('my source code'), 'source leaked into the upload')
}

function testKeepsEverythingSymbolicationNeeds() {
  console.log('\nTest: everything symbolication needs survives')
  const withContent = { ...BASE, sourcesContent: ['x'.repeat(5000)] }
  const map = JSON.parse(stripSourcesContent(JSON.stringify(withContent)).json) as EncodedSourceMap

  assert('version kept', map.version === 3)
  assert('sources kept', map.sources?.[0] === '../../src/services/catalogProducts.ts')
  assert('names kept', map.names?.length === 2)
  assert('mappings kept', map.mappings === BASE.mappings)
}

function testStrippedMapStillSymbolicates() {
  console.log('\nTest: a stripped map still resolves positions — the point of all this')
  const withContent = { ...BASE, sourcesContent: ['x'.repeat(5000)] }
  const stripped = JSON.parse(stripSourcesContent(JSON.stringify(withContent)).json) as EncodedSourceMap

  const before = symbolicate(withContent as EncodedSourceMap, 1, 4)
  const after = symbolicate(stripped, 1, 4)

  assert('it still resolves', !!after)
  assert('to the same source', after?.source === before?.source, `got: ${after?.source}`)
  assert('to the same line', after?.line === before?.line && after?.line === 10, `got: ${after?.line}`)
  assert('to the same name', after?.name === before?.name && after?.name === 'duplicate')
}

function testMapWithoutContentIsUntouched() {
  console.log('\nTest: a map with no sourcesContent is passed through byte for byte')
  const raw = JSON.stringify(BASE)
  const { json, stripped } = stripSourcesContent(raw)

  assert('nothing was stripped', !stripped)
  assert('the bytes are identical', json === raw)
}

function testUnparseableMapIsPassedThrough() {
  console.log('\nTest: an unparseable map is uploaded as-is rather than lost')
  const raw = '{ this is not json'
  const { json, stripped } = stripSourcesContent(raw)

  assert('nothing was stripped', !stripped)
  assert('the original text survives', json === raw)
}

function testSizeReductionIsRealistic() {
  console.log('\nTest: the reduction matches what a real bundle looks like')
  // Proportioned after a real Vite map measured at 2.23MB -> 580KB (-74.6%):
  // 545KB of VLQ mappings, 1,850 names, 13 sources, and sourcesContent making
  // up the remaining ~1.65MB. A degenerate fixture that is almost entirely
  // sourcesContent would report -100% and prove nothing.
  const big = {
    version: 3,
    sources: Array.from({ length: 13 }, (_, i) => `../../src/mod${i}.ts`),
    names: Array.from({ length: 1850 }, (_, i) => `n${i}`),
    mappings: 'AAAA,'.repeat(109_000),                              // ~545KB
    sourcesContent: Array.from({ length: 13 }, () => 'y'.repeat(127_000)), // ~1.65MB
  }
  const raw = JSON.stringify(big)
  const { json } = stripSourcesContent(raw)
  const pct = Math.round(100 - (json.length / raw.length) * 100)

  assert('the map is realistically large', raw.length > 2_000_000, `${raw.length} bytes`)
  assert('the reduction is in the range a real map shows (65-85%)', pct >= 65 && pct <= 85, `got -${pct}%`)
  console.log(`    ${Math.round(raw.length / 1024)}KB → ${Math.round(json.length / 1024)}KB  (-${pct}%)`)
}

function run() {
  testRemovesSourcesContent()
  testKeepsEverythingSymbolicationNeeds()
  testStrippedMapStillSymbolicates()
  testMapWithoutContentIsUntouched()
  testUnparseableMapIsPassedThrough()
  testSizeReductionIsRealistic()
  reportResults()
}

run()
