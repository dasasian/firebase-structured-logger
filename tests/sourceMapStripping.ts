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

import fs from 'fs'
import os from 'os'
import path from 'path'
import { stripSourcesContent, uploadSourceMaps, EMBEDDED_RELEASE_MARKER } from '../src/tools/uploadSourceMaps.js'
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

// --- the embed path, end to end ---

/**
 * Exercises uploadSourceMaps itself rather than the pure helper.
 *
 * The embedded copies ship INSIDE the deployed function, so if they carried
 * sourcesContent the original source would be in the deployed artifact and in
 * instance memory for the container's life. That path had no coverage — it
 * happened to be correct, which is exactly how the labels bug survived.
 *
 * The upload is pointed at a bucket that cannot exist, so it fails after the
 * embed step. That also covers the failure branch.
 */
async function testEmbedStripsSourceAndReportsFailure() {
  console.log('\nTest: --embed-sourcemaps writes a stripped map, and a failed upload is reported')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-embed-'))
  const cwd = process.cwd()
  try {
    fs.mkdirSync(path.join(tmp, 'dist', 'assets'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'functions'), { recursive: true })
    const SECRET = 'super-secret-original-source'
    fs.writeFileSync(
      path.join(tmp, 'dist', 'assets', 'app-EMBED1.js.map'),
      JSON.stringify({ ...BASE, sourcesContent: [`const KEY = "${SECRET}"`] }),
    )

    process.chdir(tmp)
    const result = await uploadSourceMaps({
      bucket: 'fsl-no-such-bucket-should-not-exist-xyz',
      release: 'r1',
      distDir: './dist',
      functionsDir: './functions',
      embedSourcemaps: true,
    })

    assert('a failed upload is reported, not swallowed', result.uploaded === false)

    const embedded = path.join(tmp, 'functions', 'sourcemaps', 'current', 'app-EMBED1.js.map')
    assert('the map was embedded', fs.existsSync(embedded))

    const text = fs.readFileSync(embedded, 'utf-8')
    assert('the embedded copy has no sourcesContent', !text.includes('sourcesContent'))
    assert('the original source is NOT in the deployed artifact', !text.includes(SECRET), 'source would ship inside the function')
    assert('the embedded map still symbolicates', JSON.parse(text).mappings === BASE.mappings)

    // The reader keys its release check on this file. It was declared, exported and
    // never written (#36), so readEmbeddedRelease() always returned null and every
    // stack resolved against the current maps whatever release it came from. The
    // reader's own tests wrote the marker themselves, so nothing caught it.
    const marker = path.join(tmp, 'functions', 'sourcemaps', 'current', EMBEDDED_RELEASE_MARKER)
    assert('the release marker was written', fs.existsSync(marker), 'the release check cannot run without it')
    assert(
      'the marker names the release being embedded',
      fs.readFileSync(marker, 'utf-8').trim() === 'r1',
      `got: ${fs.existsSync(marker) ? JSON.stringify(fs.readFileSync(marker, 'utf-8')) : 'no file'}`,
    )

    // Deleted on purpose even though the upload failed: leaving them in dist/
    // would serve source maps to browsers, which is worse than the gap.
    assert(
      'the local map is removed from dist/ so it cannot reach hosting',
      !fs.existsSync(path.join(tmp, 'dist', 'assets', 'app-EMBED1.js.map')),
    )
  } finally {
    process.chdir(cwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function run() {
  testRemovesSourcesContent()
  testKeepsEverythingSymbolicationNeeds()
  testStrippedMapStillSymbolicates()
  testMapWithoutContentIsUntouched()
  testUnparseableMapIsPassedThrough()
  testSizeReductionIsRealistic()
  await testEmbedStripsSourceAndReportsFailure()
  reportResults()
}

run().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
