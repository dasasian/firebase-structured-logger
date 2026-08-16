/**
 * Symbolication tests
 * Tests pure functions (parseStackTrace, symbolicate, formatStackTrace)
 * and the full symbolication pipeline using an embedded source map.
 *
 * The handler intentionally skips symbolication in emulator mode,
 * so the pipeline is tested directly via getSourceMap + symbolicate.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx test-symbolication.ts
 */

import fs from 'fs'
import path from 'path'

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx test-symbolication.ts')
  process.exit(1)
}

process.env.GOOGLE_APPLICATION_CREDENTIALS = './service-account.json'

import { initializeApp } from 'firebase-admin/app'
import {
  parseStackTrace,
  symbolicate,
  symbolicateStackTrace,
  formatStackTrace,
} from '../src/functions/symbolicate.js'
import { getSourceMap, clearSourceMapCache } from '../src/functions/sourceMapCache.js'
import { createClientLogHandler } from '../src/functions/logHandler.js'
import { initLogger } from '../src/functions/logger.js'
import type { LogPayload } from '../src/shared/types.js'
import type { EncodedSourceMap } from '@jridgewell/trace-mapping'
import { assert, reportResults, readLastEntry, clearLog, makeRequest } from './testHelpers.js'

initializeApp({ projectId: 'acme-app-12345' })

const LOG_DIR = './test-symbolication-output'
const SOURCE_MAP_DIR = path.join(process.cwd(), 'sourcemaps', 'current')
const BUNDLE_NAME = 'index-TEST1234.js'

fs.mkdirSync(LOG_DIR, { recursive: true })
fs.mkdirSync(SOURCE_MAP_DIR, { recursive: true })
initLogger({ appId: 'acme', logLocalDir: LOG_DIR })

// --- Source map fixture ---
// Maps:
//   bundle.js line 1, col 4  -> catalogProducts.ts line 10, col 2, name "duplicate"
//   bundle.js line 1, col 20 -> catalogProducts.ts line 25, col 0, name "handleCreate"
const TEST_SOURCE_MAP: EncodedSourceMap = {
  version: 3,
  sources: ['../../src/services/catalogProducts.ts'],
  names: ['duplicate', 'handleCreate'],
  mappings: 'IASEA,cAeFC',
}

function writeTestSourceMap() {
  fs.writeFileSync(
    path.join(SOURCE_MAP_DIR, `${BUNDLE_NAME}.map`),
    JSON.stringify(TEST_SOURCE_MAP),
  )
}

function cleanup() {
  const mapFile = path.join(SOURCE_MAP_DIR, `${BUNDLE_NAME}.map`)
  if (fs.existsSync(mapFile)) fs.unlinkSync(mapFile)
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  clearSourceMapCache()
}

// --- Tests ---

function testParseStackTraceChrome() {
  console.log('\nTest: parseStackTrace — Chrome format')
  // Chrome stacks start with the function frames (no header line)
  const frames = parseStackTrace(
    '    at duplicate (https://app.example.com/bundle.js:1:4)\n    at handleCreate (https://app.example.com/bundle.js:1:20)'
  )
  assert('parses 2 frames', frames.length === 2, `got ${frames.length}`)
  assert('frame 0 functionName', frames[0].functionName === 'duplicate')
  assert('frame 0 fileName', frames[0].fileName === 'https://app.example.com/bundle.js')
  assert('frame 0 lineNumber', frames[0].lineNumber === 1)
  assert('frame 0 columnNumber', frames[0].columnNumber === 4)
  assert('frame 1 functionName', frames[1].functionName === 'handleCreate')
  assert('frame 1 columnNumber', frames[1].columnNumber === 20)
}

function testParseStackTraceSafari() {
  console.log('\nTest: parseStackTrace — Safari/Firefox format')
  const frames = parseStackTrace(
    `duplicate@https://acme.example.com/assets/${BUNDLE_NAME}:1:4\nhandleCreate@https://acme.example.com/assets/${BUNDLE_NAME}:1:20`
  )
  assert('parses 2 frames', frames.length === 2, `got ${frames.length}`)
  assert('frame 0 functionName', frames[0].functionName === 'duplicate')
  assert('frame 0 fileName', frames[0].fileName === `https://acme.example.com/assets/${BUNDLE_NAME}`)
  assert('frame 0 lineNumber', frames[0].lineNumber === 1)
  assert('frame 0 columnNumber', frames[0].columnNumber === 4)
  assert('frame 1 functionName', frames[1].functionName === 'handleCreate')
  assert('frame 1 columnNumber', frames[1].columnNumber === 20)
}

function testSymbolicate() {
  console.log('\nTest: symbolicate — maps generated position to original')
  const r1 = symbolicate(TEST_SOURCE_MAP, 1, 4)
  assert('col 4: returns result', !!r1)
  assert('col 4: source file', r1?.source === '../../src/services/catalogProducts.ts')
  assert('col 4: line 10', r1?.line === 10)
  assert('col 4: name "duplicate"', r1?.name === 'duplicate')

  const r2 = symbolicate(TEST_SOURCE_MAP, 1, 20)
  assert('col 20: line 25', r2?.line === 25)
  assert('col 20: name "handleCreate"', r2?.name === 'handleCreate')
}

function testSymbolicateNoMatch() {
  console.log('\nTest: symbolicate — returns null for unmapped position')
  assert('null for line 99', symbolicate(TEST_SOURCE_MAP, 99, 99) === null)
}

function testFormatStackTrace() {
  console.log('\nTest: formatStackTrace')
  const formatted = formatStackTrace([
    { raw: 'ir@bundle.js:1:4', functionName: 'duplicate', fileName: '../../src/services/catalogProducts.ts', lineNumber: 10, columnNumber: 2 },
    { raw: 'x@bundle.js:1:20', functionName: 'handleCreate', fileName: '../../src/services/catalogProducts.ts', lineNumber: 25, columnNumber: 0 },
  ])
  assert('contains first function', formatted.includes('at duplicate'))
  assert('contains source file', formatted.includes('catalogProducts.ts'))
  assert('contains line number', formatted.includes(':10:'))
  assert('contains second frame', formatted.includes('at handleCreate'))
}

async function testSymbolicationPipelineWithEmbeddedSourceMap() {
  console.log('\nTest: full pipeline — embedded source map resolves minified Safari stack')
  writeTestSourceMap()
  clearSourceMapCache()

  const minifiedStack = `duplicate@https://acme.example.com/assets/${BUNDLE_NAME}:1:4\nhandleCreate@https://acme.example.com/assets/${BUNDLE_NAME}:1:20`

  const frames = parseStackTrace(minifiedStack)
  assert('parsed 2 frames', frames.length === 2)

  const sourceMap = await getSourceMap('test-release', BUNDLE_NAME)
  assert('embedded source map loaded', !!sourceMap)

  // One map covers this whole stack, so the resolver ignores the frame.
  const symbolicated = symbolicateStackTrace(frames, () => sourceMap)

  const formatted = formatStackTrace(symbolicated)
  assert('stack no longer contains bundle URL', !formatted.includes(BUNDLE_NAME), `got: ${formatted}`)
  assert('stack contains source file', formatted.includes('catalogProducts.ts'), `got: ${formatted}`)
  assert('stack contains "duplicate" at line 10', formatted.includes('duplicate') && formatted.includes(':10:'), `got: ${formatted}`)
  assert('stack contains "handleCreate" at line 25', formatted.includes('handleCreate') && formatted.includes(':25:'), `got: ${formatted}`)

  console.log('\n  Symbolicated stack:\n' + formatted.split('\n').map(l => '    ' + l).join('\n'))
}

function testMultiBundleSymbolication() {
  console.log('\nTest: symbolicateStackTrace — one stack spanning two bundles')

  // Same mappings, different source file, so each frame proves which map was used.
  const VENDOR_BUNDLE = 'vendor-TEST5678.js'
  const VENDOR_SOURCE_MAP: EncodedSourceMap = {
    ...TEST_SOURCE_MAP,
    sources: ['../../src/vendor/thirdParty.ts'],
  }

  const maps = new Map<string, EncodedSourceMap>([
    [BUNDLE_NAME, TEST_SOURCE_MAP],
    [VENDOR_BUNDLE, VENDOR_SOURCE_MAP],
  ])

  const stack = [
    `duplicate@https://acme.example.com/assets/${BUNDLE_NAME}:1:4`,
    `handleCreate@https://acme.example.com/assets/${VENDOR_BUNDLE}:1:20`,
    // A frame from a bundle we have no map for must survive untouched.
    `mystery@https://acme.example.com/assets/unknown-TEST0000.js:1:4`,
  ].join('\n')

  const frames = parseStackTrace(stack)
  assert('parsed 3 frames', frames.length === 3)

  const symbolicated = symbolicateStackTrace(frames, (frame) => {
    const bundle = frame.fileName?.match(/\/([^/]+\.js)(?:[?#].*)?$/)?.[1]
    return bundle ? maps.get(bundle) : null
  })

  const formatted = formatStackTrace(symbolicated)

  assert(
    'frame 1 resolved through the app bundle map',
    symbolicated[0].fileName === '../../src/services/catalogProducts.ts',
    `got: ${symbolicated[0].fileName}`,
  )
  assert(
    'frame 2 resolved through the vendor bundle map',
    symbolicated[1].fileName === '../../src/vendor/thirdParty.ts',
    `got: ${symbolicated[1].fileName}`,
  )
  assert(
    'frame 2 kept its own line number',
    symbolicated[1].lineNumber === 25,
    `got: ${symbolicated[1].lineNumber}`,
  )
  assert(
    'frame 3 left untouched (no source map for that bundle)',
    symbolicated[2].fileName === 'https://acme.example.com/assets/unknown-TEST0000.js',
    `got: ${symbolicated[2].fileName}`,
  )
  assert('both mapped bundle URLs are gone', !formatted.includes(BUNDLE_NAME) && !formatted.includes(VENDOR_BUNDLE), `got: ${formatted}`)

  console.log('\n  Multi-bundle stack:\n' + formatted.split('\n').map(l => '    ' + l).join('\n'))
}

async function testHandlerEmulatorSkipsSymbolication() {
  console.log('\nTest: handler in emulator mode skips symbolication (by design)')
  writeTestSourceMap()
  clearLog(LOG_DIR)
  clearSourceMapCache()

  const handler = createClientLogHandler({})
  const minifiedStack = `duplicate@https://acme.example.com/assets/${BUNDLE_NAME}:1:4`

  await handler(makeRequest({
    message: 'Test',
    severity: 'ERROR',
    labels: { appId: 'acme', releaseId: 'test-release', errorType: 'Error' },
    jsonPayload: { error: { message: 'Test', name: 'Error', stack: minifiedStack } },
  }))

  const stack = (readLastEntry(LOG_DIR)?.jsonPayload as any)?.error?.stack
  assert('stack preserved as-is (symbolication skipped in emulator)', stack === minifiedStack, `got: ${stack}`)
}

// --- Runner ---

async function run() {
  testParseStackTraceChrome()
  testParseStackTraceSafari()
  testSymbolicate()
  testSymbolicateNoMatch()
  testFormatStackTrace()
  await testSymbolicationPipelineWithEmbeddedSourceMap()
  testMultiBundleSymbolication()
  await testHandlerEmulatorSkipsSymbolication()

  cleanup()
  reportResults()
}

run().catch(err => {
  cleanup()
  console.error('Fatal:', err)
  process.exit(1)
})
