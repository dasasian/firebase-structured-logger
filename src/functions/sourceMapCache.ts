import * as fs from 'fs'
import * as path from 'path'
import { getStorage } from 'firebase-admin/storage'
import type { Bucket } from '@google-cloud/storage'
import type { EncodedSourceMap } from '@jridgewell/trace-mapping'

/**
 * Storage-map cache, bounded by approximate bytes with LRU eviction.
 *
 * This grows with releases x bundles and lives for the instance's lifetime, so
 * unbounded it is a plausible out-of-memory on a 256MB Cloud Function —
 * presenting as random instance crashes rather than a logging fault, which is
 * miserable to attribute. A real Vite map is ~580KB after `sourcesContent` is
 * stripped, and maps uploaded before 0.4.0 still carry theirs at ~2.2MB.
 *
 * Negative entries (null = confirmed not found) are exempt from the budget.
 * They cost nothing and each one prevents a repeated Storage round-trip on the
 * per-error path — more valuable since a release mismatch now consults Storage
 * first and usually misses.
 */
const MAX_CACHE_BYTES = 64 * 1024 * 1024

interface CacheEntry {
  map: EncodedSourceMap | null
  bytes: number
}

const cache = new Map<string, CacheEntry>()
let cacheBytes = 0

/** Read, moving the entry to the most-recent position. */
function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  // Map iterates in insertion order, so delete + re-insert makes it LRU.
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

function cacheSet(key: string, map: EncodedSourceMap | null, bytes: number): void {
  const existing = cache.get(key)
  if (existing) cacheBytes -= existing.bytes

  const size = map === null ? 0 : bytes
  cache.set(key, { map, bytes: size })
  cacheBytes += size

  // Evict oldest first, skipping negative entries — they are free and useful.
  for (const [k, entry] of cache) {
    if (cacheBytes <= MAX_CACHE_BYTES) break
    if (k === key || entry.map === null) continue
    cache.delete(k)
    cacheBytes -= entry.bytes
  }
}

/**
 * Test-only handle on the cache internals. Not exported from the package entry
 * point, so it is not public API — the eviction policy is worth asserting
 * directly rather than inferring from behaviour through a live bucket.
 */
export const __cacheForTests = {
  get: (key: string) => cacheGet(key),
  set: (key: string, map: EncodedSourceMap | null, bytes: number) => cacheSet(key, map, bytes),
  clear: () => clearSourceMapCache(),
  stats: () => ({ entries: cache.size, bytes: cacheBytes, limit: MAX_CACHE_BYTES }),
}

/**
 * Embedded (deployed release) maps, keyed by bundle filename.
 *
 * Deliberately unbounded: this only ever holds the maps for the one release the
 * function was deployed with, so it is bounded by that build's chunk count and
 * every entry is hot. The Storage cache is the one that grows without limit —
 * it accumulates across releases.
 */
const embeddedCache = new Map<string, EncodedSourceMap | null>()

// Which release the embedded maps belong to, written by
// `fsl upload-sourcemaps --embed-sourcemaps`. undefined = not yet read,
// null = no marker (older deploys, or embedding was never used).
let embeddedRelease: string | null | undefined

// Process-wide fallback bucket. Used by writeLog() for attachments, which has
// no per-handler config to draw on. Source-map lookups do NOT rely on this —
// they take the bucket explicitly, so two handlers configured with different
// buckets cannot silently resolve to whichever was constructed last.
let defaultBucket: string | undefined

export function configureSourceMapBucket(bucketName: string): void {
  defaultBucket = bucketName
}

/**
 * Resolve the configured Storage bucket, falling back to the project default.
 *
 * The return type is spelled out rather than inferred: without it the emitted
 * `.d.ts` would need to name `Bucket` from a path inside `node_modules`, which
 * TypeScript 7 rejects as non-portable (TS2883).
 */
export function getBucket(bucketName = defaultBucket): Bucket {
  return bucketName ? getStorage().bucket(bucketName) : getStorage().bucket()
}

/**
 * Load source map from embedded current release directory (instant for current release).
 * Result is memoised — this sits on the per-error hot path and the embedded maps
 * cannot change while the instance is alive.
 */
function loadEmbeddedSourceMap(fileName: string): EncodedSourceMap | null {
  const cached = embeddedCache.get(fileName)
  if (cached !== undefined) return cached

  const sourceMap = readEmbeddedSourceMap(fileName)
  embeddedCache.set(fileName, sourceMap)
  return sourceMap
}

/** The release the embedded maps were built from, or null if unmarked. */
function readEmbeddedRelease(): string | null {
  if (embeddedRelease !== undefined) return embeddedRelease
  try {
    const markerPath = path.join(process.cwd(), 'sourcemaps', 'current', '.release')
    embeddedRelease = fs.existsSync(markerPath)
      ? fs.readFileSync(markerPath, 'utf-8').trim() || null
      : null
  } catch {
    embeddedRelease = null
  }
  return embeddedRelease
}

function readEmbeddedSourceMap(fileName: string): EncodedSourceMap | null {
  try {
    // Looks for sourcemaps/current/{fileName}.map relative to the Cloud Function working directory
    const mapPath = path.join(process.cwd(), 'sourcemaps', 'current', `${fileName}.map`)
    if (!fs.existsSync(mapPath)) return null
    return JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as EncodedSourceMap
  } catch {
    return null
  }
}

/**
 * Load source map from Firebase Storage (for older releases).
 */
async function loadStorageSourceMap(
  releaseId: string,
  fileName: string,
  bucketName?: string,
): Promise<EncodedSourceMap | null> {
  // The bucket is part of the key: the same release/file in two buckets is two
  // different maps, and caching them under one key would serve the wrong one.
  const cacheKey = `${bucketName ?? defaultBucket ?? ''}/${releaseId}/${fileName}`
  const hit = cacheGet(cacheKey)
  if (hit) return hit.map

  try {
    const file = getBucket(bucketName).file(`sourcemaps/${releaseId}/${fileName}.map`)
    const [exists] = await file.exists()

    if (!exists) {
      cacheSet(cacheKey, null, 0)
      return null
    }

    const [content] = await file.download()
    const sourceMap = JSON.parse(content.toString()) as EncodedSourceMap
    // content.length is the byte size we already hold — no re-serialising a
    // half-megabyte object just to measure it.
    cacheSet(cacheKey, sourceMap, content.length)
    return sourceMap
  } catch (err) {
    console.warn(`[fsl] Failed to load Storage map for ${releaseId}/${fileName}:`, err)
    cacheSet(cacheKey, null, 0)
    return null
  }
}

/**
 * Get source map — checks embedded first (instant), then Storage (for old releases).
 */
/**
 * Resolve the source map for a bundle in a given release.
 *
 * The embedded directory is keyed by filename alone and holds exactly one
 * release's maps, so preferring it unconditionally meant an old stack could be
 * resolved with the CURRENT release's map — plausible-looking wrong line
 * numbers, which is worse than none. But requiring an exact match would break
 * apps that simply deploy and never version anything: they have one release's
 * maps, never need Storage, and their releaseId will not match a marker.
 *
 * So Storage is preferred only when it actually has something better:
 *
 *   matches the embedded release  -> embedded, no network
 *   differs                       -> Storage, falling back to embedded on a miss
 *
 * That is strictly better than preferring embedded in every case, and it leaves
 * the unversioned setup working exactly as before.
 */
export async function getSourceMap(
  releaseId: string,
  fileName: string,
  bucketName?: string,
): Promise<EncodedSourceMap | null> {
  const embedded = loadEmbeddedSourceMap(fileName)
  const marker = readEmbeddedRelease()

  // No marker means we cannot tell whether this stack belongs to the embedded
  // release. Older deploys have none, so keep the previous behaviour.
  if (embedded && (marker === null || marker === releaseId)) return embedded

  const stored = await loadStorageSourceMap(releaseId, fileName, bucketName)
  if (stored) return stored

  if (embedded) {
    warnReleaseFallback(releaseId, marker)
    return embedded
  }
  return null
}

// Warn once per (release, marker) pair — this sits on the per-error path.
const warnedFallbacks = new Set<string>()
function warnReleaseFallback(releaseId: string, marker: string | null): void {
  const key = `${releaseId}|${marker}`
  if (warnedFallbacks.has(key)) return
  warnedFallbacks.add(key)
  console.warn(
    `[fsl] Stack is from release '${releaseId}' but the deployed maps are for ` +
      `'${marker}', and Storage has no map for '${releaseId}'. Symbolicating with ` +
      'the deployed maps — line numbers may be wrong if the bundle changed between ' +
      'releases. If you did not mean to version releases, ignore this; if you did, ' +
      'check that the client\'s releaseId matches the one used at upload time.',
  )
}

export function clearSourceMapCache(): void {
  cache.clear()
  cacheBytes = 0
  embeddedCache.clear()
  embeddedRelease = undefined
  warnedFallbacks.clear()
}
