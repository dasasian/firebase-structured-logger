import * as fs from 'fs'
import * as path from 'path'
import { getStorage } from 'firebase-admin/storage'
import type { Bucket } from '@google-cloud/storage'
import type { EncodedSourceMap } from '@jridgewell/trace-mapping'

// In-memory cache: cacheKey → EncodedSourceMap | null (null = confirmed not found)
const cache = new Map<string, EncodedSourceMap | null>()

// Separate cache for the embedded (current release) maps, keyed by bundle filename.
const embeddedCache = new Map<string, EncodedSourceMap | null>()

let configuredBucket: string | undefined

export function configureSourceMapBucket(bucketName: string): void {
  configuredBucket = bucketName
}

/**
 * Resolve the configured Storage bucket, falling back to the project default.
 *
 * The return type is spelled out rather than inferred: without it the emitted
 * `.d.ts` would need to name `Bucket` from a path inside `node_modules`, which
 * TypeScript 7 rejects as non-portable (TS2883).
 */
export function getBucket(bucketName = configuredBucket): Bucket {
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
): Promise<EncodedSourceMap | null> {
  const cacheKey = `${releaseId}/${fileName}`
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null

  try {
    const file = getBucket().file(`sourcemaps/${releaseId}/${fileName}.map`)
    const [exists] = await file.exists()

    if (!exists) {
      cache.set(cacheKey, null)
      return null
    }

    const [content] = await file.download()
    const sourceMap = JSON.parse(content.toString()) as EncodedSourceMap
    cache.set(cacheKey, sourceMap)
    return sourceMap
  } catch (err) {
    console.warn(`[fsl] Failed to load Storage map for ${releaseId}/${fileName}:`, err)
    cache.set(`${releaseId}/${fileName}`, null)
    return null
  }
}

/**
 * Get source map — checks embedded first (instant), then Storage (for old releases).
 */
export async function getSourceMap(
  releaseId: string,
  fileName: string,
): Promise<EncodedSourceMap | null> {
  const embedded = loadEmbeddedSourceMap(fileName)
  if (embedded) return embedded
  return loadStorageSourceMap(releaseId, fileName)
}

export function clearSourceMapCache(): void {
  cache.clear()
  embeddedCache.clear()
}
