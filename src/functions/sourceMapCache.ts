import * as fs from 'fs'
import * as path from 'path'
import { getStorage } from 'firebase-admin/storage'
import type { SourceMapObject } from './symbolicate'

// In-memory cache: cacheKey → SourceMapObject | null (null = confirmed not found)
const cache = new Map<string, SourceMapObject | null>()

let configuredBucket: string | undefined

export function configureSourceMapBucket(bucketName: string): void {
  configuredBucket = bucketName
}

export function getConfiguredBucket(): string | undefined {
  return configuredBucket
}

/**
 * Load source map from embedded current release directory (instant for current release).
 */
function loadEmbeddedSourceMap(fileName: string): SourceMapObject | null {
  try {
    // Looks for sourcemaps/current/{fileName}.map relative to the Cloud Function working directory
    const mapPath = path.join(process.cwd(), 'sourcemaps', 'current', `${fileName}.map`)
    if (!fs.existsSync(mapPath)) return null
    return JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as SourceMapObject
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
): Promise<SourceMapObject | null> {
  const cacheKey = `${releaseId}/${fileName}`
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null

  try {
    const bucket = configuredBucket
      ? getStorage().bucket(configuredBucket)
      : getStorage().bucket()
    const file = bucket.file(`sourcemaps/${releaseId}/${fileName}.map`)
    const [exists] = await file.exists()

    if (!exists) {
      cache.set(cacheKey, null)
      return null
    }

    const [content] = await file.download()
    const sourceMap = JSON.parse(content.toString()) as SourceMapObject
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
): Promise<SourceMapObject | null> {
  const embedded = loadEmbeddedSourceMap(fileName)
  if (embedded) return embedded
  return loadStorageSourceMap(releaseId, fileName)
}

export function clearSourceMapCache(): void {
  cache.clear()
}
