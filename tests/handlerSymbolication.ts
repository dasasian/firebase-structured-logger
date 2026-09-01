/**
 * End-to-end handler symbolication.
 *
 * `tests/symbolication.ts` covers `symbolicate()` and `symbolicateStackTrace()`
 * directly. The HANDLER's own orchestration is a different thing and was
 * covered by nothing: bundleFileFromUrl → a Set of unique bundles → Promise.all
 * of getSourceMap → a per-frame resolver → formatStackTrace. That code was
 * refactored twice in August on typecheck alone, and it is where the
 * per-handler bucket bug (16a9667) lived.
 *
 * No cloud is involved. `getSourceMap` checks the embedded map BEFORE falling
 * through to Storage, so maps written to sourcemaps/current/ satisfy the whole
 * path — no credentials, no emulator, no Java.
 *
 * Run with FUNCTIONS_EMULATOR **unset**: `logHandler.ts:103` skips symbolication
 * when it is 'true'. That is an environment variable, not a process — nothing
 * needs to be started.
 *
 *   npx tsx tests/handlerSymbolication.ts
 */

if (process.env.FUNCTIONS_EMULATOR === 'true') {
  console.error('Run with FUNCTIONS_EMULATOR unset — that flag disables symbolication')
  process.exit(1)
}

import fs from 'fs'
import path from 'path'
import { initializeApp } from 'firebase-admin/app'
import { createClientLogHandler } from '../src/functions/logHandler.js'
import { initLogger } from '../src/functions/logger.js'
import { clearSourceMapCache } from '../src/functions/sourceMapCache.js'
import type { LogPayload } from '../src/shared/types.js'
import type { EncodedSourceMap } from '@jridgewell/trace-mapping'
import { assert, reportResults, makeRequest } from './testHelpers.js'

initializeApp({ projectId: 'demo-fsl-handler' })
initLogger({ appId: 'acme', minSeverity: 'DEBUG' })

const MAP_DIR = path.join(process.cwd(), 'sourcemaps', 'current')

// Distinct from tests/symbolication.ts's index-TEST1234.js — npm test runs both
// in the same working directory, so a shared fixture name would let one suite's
// map silently satisfy the other's lookup.
const APP_BUNDLE = 'app-HANDLER1.js'
const VENDOR_BUNDLE = 'vendor-HANDLER2.js'
const UNMAPPED_BUNDLE = 'orphan-HANDLER3.js'

// col 4 -> catalogProducts.ts:10:2 "duplicate", col 20 -> :25:0 "handleCreate"
const APP_MAP: EncodedSourceMap = {
  version: 3,
  sources: ['../../src/services/catalogProducts.ts'],
  names: ['duplicate', 'handleCreate'],
  mappings: 'IASEA,cAeFC',
}
const VENDOR_MAP: EncodedSourceMap = { ...APP_MAP, sources: ['../../src/vendor/thirdParty.ts'] }

function writeMap(bundle: string, map: unknown): void {
  fs.mkdirSync(MAP_DIR, { recursive: true })
  fs.writeFileSync(path.join(MAP_DIR, `${bundle}.map`), JSON.stringify(map))
}

function removeMaps(): void {
  for (const b of [APP_BUNDLE, VENDOR_BUNDLE, UNMAPPED_BUNDLE]) {
    const f = path.join(MAP_DIR, `${b}.map`)
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  clearSourceMapCache()
}

const frame = (fn: string, bundle: string, col: number) =>
  `${fn}@https://app.example.com/assets/${bundle}:1:${col}`

/**
 * Drive the handler and return the entry Cloud Logging would receive.
 * ERROR routes to console.error, so stderr is what must be captured.
 */
async function runHandler(
  payload: Partial<LogPayload> & { stack?: string },
  config: Parameters<typeof createClientLogHandler>[0] = {},
): Promise<Record<string, unknown> | undefined> {
  const lines: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const grab = ((c: unknown) => {
    lines.push(String(c))
    return true
  }) as typeof process.stdout.write

  const data: LogPayload = {
    message: payload.message ?? 'boom',
    severity: payload.severity ?? 'ERROR',
    labels: (payload.labels ?? { appId: 'acme', releaseId: 'rel-1' }) as LogPayload['labels'],
    jsonPayload:
      payload.jsonPayload ??
      (payload.stack
        ? { error: { message: 'boom', name: 'Error', stack: payload.stack } }
        : undefined),
  }

  process.stdout.write = grab
  process.stderr.write = grab
  try {
    await createClientLogHandler(config)(makeRequest(data))
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }

  const line = lines.join('').split('\n').find((l) => l.trim().startsWith('{'))
  return line ? (JSON.parse(line) as Record<string, unknown>) : undefined
}

/**
 * Where the symbolicated stack ends up.
 *
 * BREAKING in 0.7.0: a reportable error carries its stack at top-level
 * `stack_trace`, so Cloud Error Reporting can see it (#31), and its `error`
 * object no longer has a `stack` key — one copy, not two, in an entry capped at
 * 256 KB. Anything below ERROR, and anything marked as feedback, keeps its stack
 * under `error` as before, so both are checked here.
 */
const stackOf = (entry: Record<string, unknown> | undefined): string =>
  (entry?.stack_trace as string | undefined) ??
  (entry?.error as { stack?: string } | undefined)?.stack ??
  ''

// --- Happy path ---

async function testMinifiedStackResolvesToSource() {
  console.log('\nTest: a minified stack comes back resolved to source')
  removeMaps()
  writeMap(APP_BUNDLE, APP_MAP)

  const stack = stackOf(await runHandler({ stack: frame('duplicate', APP_BUNDLE, 4) }))

  assert('the bundle URL is gone', !stack.includes(APP_BUNDLE), `got: ${stack}`)
  assert('it names the source file', stack.includes('catalogProducts.ts'), `got: ${stack}`)
  assert('it names the source line', stack.includes(':10:'), `got: ${stack}`)
  assert('the function name survives', stack.includes('duplicate'), `got: ${stack}`)
}

async function testMultiBundleStack() {
  console.log('\nTest: one stack spanning two bundles resolves each through its own map')
  removeMaps()
  writeMap(APP_BUNDLE, APP_MAP)
  writeMap(VENDOR_BUNDLE, VENDOR_MAP)

  const stack = stackOf(
    await runHandler({
      stack: [frame('duplicate', APP_BUNDLE, 4), frame('handleCreate', VENDOR_BUNDLE, 20)].join('\n'),
    }),
  )

  assert('frame 1 used the app map', stack.includes('catalogProducts.ts'), `got: ${stack}`)
  assert('frame 2 used the vendor map', stack.includes('thirdParty.ts'), `got: ${stack}`)
  assert('both bundle URLs are gone', !stack.includes(APP_BUNDLE) && !stack.includes(VENDOR_BUNDLE), `got: ${stack}`)
}

// --- Graceful degradation ---

async function testPartialCoverage() {
  console.log('\nTest: unmapped frames are preserved while mapped ones resolve')
  removeMaps()
  writeMap(APP_BUNDLE, APP_MAP)   // no map for UNMAPPED_BUNDLE

  const stack = stackOf(
    await runHandler({
      stack: [frame('duplicate', APP_BUNDLE, 4), frame('mystery', UNMAPPED_BUNDLE, 4)].join('\n'),
    }),
  )

  assert('the mapped frame resolved', stack.includes('catalogProducts.ts'), `got: ${stack}`)
  assert('the unmapped frame kept its bundle', stack.includes(UNMAPPED_BUNDLE), `got: ${stack}`)
  assert('the unmapped function name survives', stack.includes('mystery'), `got: ${stack}`)
}

async function testNoMapsAtAll() {
  console.log('\nTest: with no maps the original stack is returned untouched')
  removeMaps()

  const original = frame('duplicate', APP_BUNDLE, 4)
  const stack = stackOf(await runHandler({ stack: original }))

  assert('the stack is unchanged', stack === original, `got: ${stack}`)
}

async function testMalformedMapDoesNotCrash() {
  console.log('\nTest: a malformed map on disk is survived, not thrown')
  // Note on what this does NOT prove: the JSON parse failure is caught one
  // layer down in readEmbeddedSourceMap, which returns null, so the handler
  // sees "no map" rather than an exception. symbolicateError's own catch is
  // defence in depth and is not reachable from here — removing it does not
  // fail this suite. Worth knowing before trusting it as coverage of that
  // branch.
  removeMaps()
  fs.mkdirSync(MAP_DIR, { recursive: true })
  fs.writeFileSync(path.join(MAP_DIR, `${APP_BUNDLE}.map`), '{ not valid json')

  const original = frame('duplicate', APP_BUNDLE, 4)
  let threw = false
  let stack = ''
  try {
    stack = stackOf(await runHandler({ stack: original }))
  } catch {
    threw = true
  }

  assert('nothing was thrown', !threw)
  assert('the original stack survived', stack === original, `got: ${stack}`)
}

async function testNonBundleUrlIsLeftAlone() {
  console.log('\nTest: a frame whose file is not a .js bundle is left alone')
  removeMaps()
  writeMap(APP_BUNDLE, APP_MAP)

  const html = 'inline@https://app.example.com/checkout:12:3'
  const stack = stackOf(
    await runHandler({ stack: [frame('duplicate', APP_BUNDLE, 4), html].join('\n') }),
  )

  assert('the mapped frame resolved', stack.includes('catalogProducts.ts'), `got: ${stack}`)
  assert('the non-bundle frame is preserved', stack.includes('/checkout'), `got: ${stack}`)
}

async function testFrameWithoutPositionIsPreserved() {
  console.log('\nTest: a frame with no line/column is passed through')
  removeMaps()
  writeMap(APP_BUNDLE, APP_MAP)

  const stack = stackOf(
    await runHandler({ stack: ['Error: boom', frame('duplicate', APP_BUNDLE, 4)].join('\n') }),
  )

  assert('the header line survives', stack.includes('Error: boom'), `got: ${stack}`)
  assert('the real frame still resolved', stack.includes('catalogProducts.ts'), `got: ${stack}`)
}

// --- Entries that should not be symbolicated ---

async function testNonErrorEntrySkipsSymbolication() {
  console.log('\nTest: an entry with no stack skips symbolication entirely')
  removeMaps()
  writeMap(APP_BUNDLE, APP_MAP)

  const entry = await runHandler({
    message: 'just info',
    severity: 'INFO',
    jsonPayload: { context: { a: 1 } },
  })

  assert('the entry was still written', !!entry, 'handler produced nothing')
  assert('no error key was invented', !('error' in (entry ?? {})), `keys: ${Object.keys(entry ?? {}).join(', ')}`)
  assert('the message came through', entry?.message === 'just info')
}

// --- Release scoping ---

async function testReleaseIdFallsBackToUnknown() {
  console.log('\nTest: a missing releaseId falls back to "unknown" without failing')
  removeMaps()
  writeMap(APP_BUNDLE, APP_MAP)

  // The embedded lookup ignores releaseId, so symbolication must still work.
  const stack = stackOf(
    await runHandler({
      labels: { appId: 'acme' } as LogPayload['labels'],
      stack: frame('duplicate', APP_BUNDLE, 4),
    }),
  )

  assert('it still symbolicated', stack.includes('catalogProducts.ts'), `got: ${stack}`)
}

async function testPerHandlerBucketDoesNotBreakEmbedded() {
  console.log('\nTest: a handler configured with a bucket still uses embedded maps first')
  removeMaps()
  writeMap(APP_BUNDLE, APP_MAP)

  // Two handlers with different buckets. The embedded path ignores the bucket,
  // so both must resolve — this asserts the wiring from 16a9667 survives.
  const a = stackOf(await runHandler({ stack: frame('duplicate', APP_BUNDLE, 4) }, { bucketName: 'app-a-maps' }))
  const b = stackOf(await runHandler({ stack: frame('duplicate', APP_BUNDLE, 4) }, { bucketName: 'app-b-maps' }))

  assert('handler A symbolicated', a.includes('catalogProducts.ts'), `got: ${a}`)
  assert('handler B symbolicated', b.includes('catalogProducts.ts'), `got: ${b}`)
}

// --- Runner ---

async function run() {
  await testMinifiedStackResolvesToSource()
  await testMultiBundleStack()
  await testPartialCoverage()
  await testNoMapsAtAll()
  await testMalformedMapDoesNotCrash()
  await testNonBundleUrlIsLeftAlone()
  await testFrameWithoutPositionIsPreserved()
  await testNonErrorEntrySkipsSymbolication()
  await testReleaseIdFallsBackToUnknown()
  await testPerHandlerBucketDoesNotBreakEmbedded()

  removeMaps()
  fs.rmSync(path.join(process.cwd(), 'sourcemaps'), { recursive: true, force: true })
  reportResults()
}

run().catch((err) => {
  removeMaps()
  fs.rmSync(path.join(process.cwd(), 'sourcemaps'), { recursive: true, force: true })
  console.error('Fatal:', err)
  process.exit(1)
})
