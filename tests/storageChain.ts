/**
 * The Storage chain: firebase-admin, then a named bucket, then nothing.
 *
 * firebase-admin is an optional peer, and `/functions` has to work on a backend
 * without it (#39). Storage is resolved on first use down three steps — see
 * loadFirebaseAdminStorage in sourceMapCache.ts. The package is in this repo's
 * devDependencies, so "not installed" is staged with a require hook that refuses it.
 *
 * Runs with FUNCTIONS_EMULATOR unset: the attachment case goes through writeLog's
 * production branch, which is the one that writes the labels Cloud Logging sees.
 *
 * Run: npx tsx tests/storageChain.ts
 */

if (process.env.FUNCTIONS_EMULATOR === 'true') {
  console.error('Run with FUNCTIONS_EMULATOR unset — the attachment case needs the production branch')
  process.exit(1)
}

import * as fs from 'fs'
import * as path from 'path'
import Module from 'module'
import { initializeApp } from 'firebase-admin/app'
import {
  getBucket,
  getSourceMap,
  storageSource,
  resetStorageResolution,
  clearSourceMapCache,
  resetSourceMapWarnings,
} from '../src/functions/sourceMapCache.js'
import { initLogger, writeLog } from '../src/functions/logger.js'
import { embeddedDir, embeddedMapPath } from '../src/shared/paths.js'
import { assert, reportResults } from './testHelpers.js'

// Any real upload fails fast on a closed local port, never reaching real Storage.
process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9'
initializeApp({ projectId: 'demo-storage-chain' })
initLogger({ appId: 'chain', minSeverity: 'DEBUG' })

// --- staging "firebase-admin is not installed" ---

type Load = (request: string, parent: unknown, isMain: boolean) => unknown
const loader = Module as unknown as { _load: Load }
const realLoad = loader._load

/** Refuse firebase-admin until the returned function is called. */
function blockFirebaseAdmin(): () => void {
  loader._load = function (request, parent, isMain) {
    if (request.startsWith('firebase-admin')) {
      throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' })
    }
    return realLoad.call(this, request, parent, isMain)
  }
  return () => {
    loader._load = realLoad
  }
}

function withoutFirebaseAdmin<T>(fn: () => T): T {
  const restore = blockFirebaseAdmin()
  try {
    return fn()
  } finally {
    restore()
  }
}

function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = realWarn
  }
}

function freshChain() {
  resetStorageResolution()
  resetSourceMapWarnings()
  clearSourceMapCache()
}

// --- the three steps ---

function testFirebaseAdminIsPreferred() {
  console.log('\nTest: step 1 — with firebase-admin installed, it is used')
  freshChain()
  assert('the source is firebase-admin', storageSource('b') === 'firebase-admin')
  assert('a named bucket resolves', getBucket('chain-bucket')?.name === 'chain-bucket')
}

function testNamedBucketWithoutFirebaseAdmin() {
  console.log('\nTest: step 2 — without firebase-admin, a named bucket uses @google-cloud/storage')
  freshChain()
  withoutFirebaseAdmin(() => {
    assert('the source is google-cloud-storage', storageSource('chain-bucket') === 'google-cloud-storage')
    const { result: bucket, warnings } = captureWarnings(() => getBucket('chain-bucket'))
    assert('the bucket resolves', bucket?.name === 'chain-bucket', `got ${bucket?.name}`)
    assert('nothing is warned', warnings.length === 0, warnings.join('\n'))
  })
}

function testNoStorageWarnsOnce() {
  console.log('\nTest: step 3 — no firebase-admin and no bucket: null, and one warning')
  freshChain()
  withoutFirebaseAdmin(() => {
    assert('the source is none', storageSource(undefined) === 'none')
    const { result, warnings } = captureWarnings(() => [getBucket(undefined), getBucket(undefined)])
    assert('there is no bucket', result[0] === null && result[1] === null)
    assert('the warning names the cause', warnings[0]?.includes('firebase-admin is not installed and no bucket is named'))
    assert('it is warned once, not per call', warnings.filter((w) => w.includes('No Storage')).length === 1)
  })
}

async function testEmbeddedMapsStillResolveWithoutStorage() {
  console.log('\nTest: step 3 — the embedded map still resolves; a missing one says Storage is unavailable')
  freshChain()
  const fixture = 'app-CHAIN1.js'
  fs.mkdirSync(embeddedDir(process.cwd()), { recursive: true })
  fs.writeFileSync(
    embeddedMapPath(process.cwd(), fixture),
    JSON.stringify({ version: 3, sources: ['chain.ts'], names: [], mappings: '' }),
  )
  const restore = blockFirebaseAdmin()
  try {
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
    try {
      const embedded = await getSourceMap('any-release', fixture)
      assert('the embedded map resolves', embedded?.sources?.[0] === 'chain.ts')
      const missing = await getSourceMap('old-release', 'app-MISSING.js')
      assert('a missing map is null, not a throw', missing === null)
      assert(
        'the miss says Storage is not available',
        warnings.some((w) => w.includes('storage:  not available')),
        warnings.join('\n'),
      )
    } finally {
      console.warn = realWarn
    }
  } finally {
    restore()
    fs.rmSync(embeddedMapPath(process.cwd(), fixture), { force: true })
  }
}

function testAttachmentsDroppedEntryKept() {
  console.log('\nTest: step 3 — an attachment is dropped, the entry is kept, and not labelled')
  freshChain()
  const lines: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const grab = ((chunk: unknown) => (lines.push(String(chunk)), true)) as typeof process.stdout.write
  const { warnings } = captureWarnings(() =>
    withoutFirebaseAdmin(() => {
      process.stdout.write = grab
      process.stderr.write = grab
      try {
        writeLog({
          message: 'chain attachment',
          severity: 'INFO',
          labels: { appId: 'chain' } as never,
          attachments: { note: Buffer.from('hi').toString('base64') },
        })
      } finally {
        process.stdout.write = realOut
        process.stderr.write = realErr
      }
    }),
  )
  const entry = lines
    .join('')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((e) => e.message === 'chain attachment')
  const labels = entry?.['logging.googleapis.com/labels'] as Record<string, string> | undefined
  assert('the entry is written', entry !== undefined)
  assert('hasAttachments is not claimed', labels?.hasAttachments === undefined, `got ${labels?.hasAttachments}`)
  assert('the reason is warned', warnings.some((w) => w.includes('No Storage')))
}

async function run() {
  testFirebaseAdminIsPreferred()
  testNamedBucketWithoutFirebaseAdmin()
  testNoStorageWarnsOnce()
  await testEmbeddedMapsStillResolveWithoutStorage()
  testAttachmentsDroppedEntryKept()
  fs.rmSync(path.join(process.cwd(), 'sourcemaps'), { recursive: true, force: true })
  reportResults()
}

run()
