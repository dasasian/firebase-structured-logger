/**
 * The Storage source-map cache key includes the bucket and the prefix.
 *
 * The same release and file under two buckets, or two prefixes, are different
 * objects. A key without them would serve the first one fetched to every later
 * caller. Storage is staged with a require hook that supplies a fake
 * firebase-admin/storage, so no cloud is involved.
 *
 * Run: npx tsx tests/sourceMapCacheKey.ts
 */

if (process.env.FUNCTIONS_EMULATOR === 'true') {
  console.error('Run with FUNCTIONS_EMULATOR unset — an emulator-mode run would not reach the Storage lookup')
  process.exit(1)
}

import Module from 'module'
import { getSourceMap, clearSourceMapCache, resetStorageResolution } from '../src/functions/sourceMapCache.js'
import { assert, reportResults } from './testHelpers.js'

type Load = (request: string, parent: unknown, isMain: boolean) => unknown
const loader = Module as unknown as { _load: Load }
const realLoad = loader._load

const fakeStorage = {
  getStorage: () => ({
    bucket: (bucketName = 'default-bucket') => ({
      file: (objectPath: string) => ({
        exists: async () => [true],
        download: async () => [
          Buffer.from(JSON.stringify({ version: 3, sources: [`${bucketName}:${objectPath}`], names: [], mappings: 'AAAA' })),
        ],
      }),
    }),
  }),
}

function withFakeFirebaseAdminStorage(): () => void {
  loader._load = function (request, parent, isMain) {
    if (request === 'firebase-admin/storage') return fakeStorage
    return realLoad.call(this, request, parent, isMain)
  }
  return () => {
    loader._load = realLoad
  }
}

async function testBucketsDoNotShareAnEntry() {
  console.log('\nTest: the same release and file in two buckets are two maps')
  const first = await getSourceMap('r1', 'no-embedded.js', 'bucket-a')
  const second = await getSourceMap('r1', 'no-embedded.js', 'bucket-b')

  assert('the first came from bucket-a', first?.sources?.[0]?.startsWith('bucket-a:') === true, `${first?.sources}`)
  assert(
    'the second came from bucket-b, not the cached first',
    second?.sources?.[0]?.startsWith('bucket-b:') === true,
    `${second?.sources}`,
  )
}

async function testPrefixesDoNotShareAnEntry() {
  console.log('\nTest: the same release and file under two prefixes are two maps')
  clearSourceMapCache()
  const first = await getSourceMap('r2', 'no-embedded.js', 'bucket-a', 'one')
  const second = await getSourceMap('r2', 'no-embedded.js', 'bucket-a', 'two')

  assert('the first came from prefix one', first?.sources?.[0]?.includes('one/') === true, `${first?.sources}`)
  assert(
    'the second came from prefix two, not the cached first',
    second?.sources?.[0]?.includes('two/') === true,
    `${second?.sources}`,
  )
}

async function run() {
  const restore = withFakeFirebaseAdminStorage()
  resetStorageResolution()
  clearSourceMapCache()
  try {
    await testBucketsDoNotShareAnEntry()
    await testPrefixesDoNotShareAnEntry()
  } finally {
    restore()
    resetStorageResolution()
  }
  reportResults()
}

void run()
