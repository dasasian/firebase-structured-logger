/**
 * Which source map wins, and why (#20).
 *
 * The embedded directory is keyed by filename alone and holds exactly one
 * release's maps. Preferring it unconditionally meant a stack from an OLD
 * release could be resolved with the CURRENT release's map — plausible-looking
 * wrong line numbers, which is worse than no symbolication because nothing
 * signals it.
 *
 * But requiring an exact release match would break apps that simply deploy and
 * never version: one release's maps, never need Storage, and a releaseId that
 * will not match the marker. So Storage is preferred only when it actually has
 * something better.
 *
 * Run with FUNCTIONS_EMULATOR unset (no cloud is reached — Storage lookups miss):
 *   npx tsx tests/releaseResolution.ts
 */

import fs from 'fs'
import path from 'path'
import { initializeApp } from 'firebase-admin/app'
import { getSourceMap, clearSourceMapCache } from '../src/functions/sourceMapCache.js'
import type { EncodedSourceMap } from '@jridgewell/trace-mapping'
import { assert, reportResults } from './testHelpers.js'

initializeApp({ projectId: 'demo-release-resolution' })

const MAP_DIR = path.join(process.cwd(), 'sourcemaps', 'current')
const BUNDLE = 'app-RELEASE1.js'
const MAP: EncodedSourceMap = {
  version: 3,
  sources: ['../../src/embedded.ts'],
  names: [],
  mappings: 'AAAA',
}

function embed(releaseId: string | null): void {
  fs.mkdirSync(MAP_DIR, { recursive: true })
  fs.writeFileSync(path.join(MAP_DIR, `${BUNDLE}.map`), JSON.stringify(MAP))
  const marker = path.join(MAP_DIR, '.release')
  if (releaseId === null) {
    if (fs.existsSync(marker)) fs.unlinkSync(marker)
  } else {
    fs.writeFileSync(marker, releaseId)
  }
  clearSourceMapCache()
}

function cleanup(): void {
  fs.rmSync(path.join(process.cwd(), 'sourcemaps'), { recursive: true, force: true })
  clearSourceMapCache()
}

// --- The three setups from the design ---

async function testMatchingReleaseUsesEmbedded() {
  console.log('\nTest: a stack from the deployed release uses the embedded map')
  embed('a1b2c3')

  const map = await getSourceMap('a1b2c3', BUNDLE)
  assert('resolved', !!map)
  assert('it is the embedded map', map?.sources?.[0] === '../../src/embedded.ts')
}

async function testUnversionedAppStillWorks() {
  console.log('\nTest: an unversioned app still symbolicates — the setup a strict match would have broken')
  embed('a1b2c3')

  // The client sends 'dev' because nothing sets VITE_RELEASE_ID. Storage has
  // nothing under 'dev'. Before falling back, this would resolve to nothing.
  const map = await getSourceMap('dev', BUNDLE)
  assert('it still resolved', !!map, 'an unversioned deploy lost symbolication')
  assert('via the embedded map', map?.sources?.[0] === '../../src/embedded.ts')
}

async function testUnmarkedEmbedKeepsOldBehaviour() {
  console.log('\nTest: an embed with no marker behaves as before')
  embed(null) // deployed before markers existed

  const map = await getSourceMap('any-release-at-all', BUNDLE)
  assert('it resolved', !!map, 'older deploys must keep working')
}

async function testMismatchPrefersStorage() {
  console.log('\nTest: a mismatched release consults Storage before falling back')
  embed('a1b2c3')

  // No live Storage here, so the lookup misses and we fall back — but the
  // attempt is the point. With a real bucket holding v1's map, that map wins.
  const map = await getSourceMap('v1-old-release', BUNDLE)
  assert('it still resolved rather than failing', !!map)

  // The fall-back is the untrustworthy case, so it must be announced.
  // Match the mismatch warning specifically. loadStorageSourceMap also logs on
  // failure and its message contains the release id too, so a looser filter
  // catches both and the count assertion below becomes meaningless.
  assert('a warning names the mismatch', mismatchWarnings().some((w) => w.includes('v1-old-release') && w.includes('a1b2c3')),
    `warnings: ${JSON.stringify(warned)}`)
}

async function testNoEmbeddedMapAtAll() {
  console.log('\nTest: no embedded map and no Storage map resolves to null')
  cleanup()

  const map = await getSourceMap('whatever', 'no-such-bundle.js')
  assert('resolved to null', map === null)
}

async function testWarningIsNotRepeatedPerError() {
  console.log('\nTest: the mismatch warning is emitted once, not per error')
  embed('a1b2c3')
  warned.length = 0

  for (let i = 0; i < 5; i++) await getSourceMap('v1-old-release', BUNDLE)
  assert('warned exactly once across 5 lookups', mismatchWarnings().length === 1,
    `got ${mismatchWarnings().length}: ${JSON.stringify(mismatchWarnings())}`)
}

// --- capture console.warn ---

const warned: string[] = []

/** Only the release-mismatch warning, not Storage's own failure logging. */
const mismatchWarnings = () => warned.filter((w) => w.includes('Symbolicating with'))
const realWarn = console.warn.bind(console)
console.warn = (...args: unknown[]) => {
  warned.push(args.map(String).join(' '))
}

async function run() {
  try {
    await testMatchingReleaseUsesEmbedded()
    await testUnversionedAppStillWorks()
    await testUnmarkedEmbedKeepsOldBehaviour()
    await testMismatchPrefersStorage()
    await testNoEmbeddedMapAtAll()
    await testWarningIsNotRepeatedPerError()
  } finally {
    console.warn = realWarn
    cleanup()
  }
  reportResults()
}

run().catch((err) => {
  console.warn = realWarn
  cleanup()
  console.error('Fatal:', err)
  process.exit(1)
})
