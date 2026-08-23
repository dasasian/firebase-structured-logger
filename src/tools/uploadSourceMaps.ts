import * as fs from 'fs'
import * as path from 'path'
import { Storage } from '@google-cloud/storage'

export interface UploadOptions {
  bucket: string        // resolved by caller — falls back to env vars in CLI
  release?: string
  distDir?: string
  functionsDir?: string // path to Cloud Functions directory (e.g. './functions' or './backend')
  embedSourcemaps?: boolean  // copy maps to {functionsDir}/sourcemaps/current/ (default false)
}

/**
 * Drop `sourcesContent` from a source map, returning the JSON to store.
 *
 * `sourcesContent` inlines the ENTIRE original source of every file the bundle
 * covers. Symbolication never reads it — `originalPositionFor` needs only
 * `sources`, `names` and `mappings` — so uploading it costs storage, download
 * time on the per-error path, and Cloud Function memory, for nothing.
 *
 * It is also your source code. Uploading maps verbatim means a logging tool
 * quietly ships your source into a Storage bucket, where a misconfiguration
 * turns a logging concern into a source-code leak.
 *
 * Measured on a real Vite bundle: 2.23 MB -> 580 KB, a 74.6% reduction.
 *
 * Returns the original text unchanged if it is not parseable JSON, so an odd
 * map is uploaded as-is rather than lost.
 */
export function stripSourcesContent(raw: string): { json: string; stripped: boolean } {
  try {
    const map = JSON.parse(raw) as Record<string, unknown>
    if (!('sourcesContent' in map)) return { json: raw, stripped: false }
    delete map.sourcesContent
    return { json: JSON.stringify(map), stripped: true }
  } catch {
    return { json: raw, stripped: false }
  }
}

function readStrippedMap(localPath: string): { json: string; before: number; after: number } {
  const raw = fs.readFileSync(localPath, 'utf-8')
  const { json } = stripSourcesContent(raw)
  return { json, before: Buffer.byteLength(raw), after: Buffer.byteLength(json) }
}

const kb = (bytes: number) => `${Math.round(bytes / 1024)}KB`

function findMapFiles(dir: string): string[] {
  const results: string[] = []

  if (!fs.existsSync(dir)) return results

  function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.map')) {
        results.push(full)
      }
    }
  }

  walk(dir)
  return results
}

export async function uploadSourceMaps(options: UploadOptions): Promise<void> {
  const releaseId = options.release ?? process.env.VITE_RELEASE_ID ?? process.env.RELEASE_ID
  if (!releaseId) {
    console.error('[fsl] Release ID required. Set RELEASE_ID (or VITE_RELEASE_ID) in .env.local or pass --release=<id>.')
    process.exit(1)
  }
  const distDir = options.distDir ?? path.join(process.cwd(), 'dist')
  const mapFiles = findMapFiles(distDir)

  if (mapFiles.length === 0) {
    console.log('[fsl] No .map files found in', distDir)
    return
  }

  console.log(`[fsl] Uploading ${mapFiles.length} source map(s) for release ${releaseId}...`)

  // Embed maps into functions directory before uploading (for fast lookup of current release)
  if (options.embedSourcemaps && options.functionsDir) {
    const embedDir = path.join(process.cwd(), options.functionsDir, 'sourcemaps', 'current')
    fs.mkdirSync(embedDir, { recursive: true })
    for (const f of fs.readdirSync(embedDir)) {
      fs.unlinkSync(path.join(embedDir, f))
    }
    for (const localPath of mapFiles) {
      const dest = path.join(embedDir, path.basename(localPath))
      // Stripped here too: these ship inside the deployed function, so the
      // content would inflate the deploy and sit in memory for the instance's life.
      const { json, before, after } = readStrippedMap(localPath)
      fs.writeFileSync(dest, json)
      const saved = before > after ? ` (${kb(before)} → ${kb(after)})` : ''
      console.log(`  ✓ embedded ${path.basename(localPath)} → ${options.functionsDir}/sourcemaps/current/${saved}`)
    }
  }

  // Authenticate via service account key if available, otherwise fall back to ADC
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  const storageOptions = serviceAccountPath && fs.existsSync(serviceAccountPath)
    ? { keyFilename: serviceAccountPath }
    : {}
  const storage = new Storage(storageOptions)
  const bucket = storage.bucket(options.bucket)

  try {
    for (const localPath of mapFiles) {
      const fileName = path.basename(localPath)
      const destination = `sourcemaps/${releaseId}/${fileName}`

      const { json, before, after } = readStrippedMap(localPath)
      await bucket.file(destination).save(json, { contentType: 'application/json' })
      const saved = before > after ? ` (${kb(before)} → ${kb(after)}, -${Math.round(100 - (after / before) * 100)}%)` : ''
      console.log(`  ✓ ${fileName} → gs://${options.bucket}/${destination}${saved}`)

      // Delete local .map file after upload
      fs.unlinkSync(localPath)
      console.log(`  ✗ deleted ${path.relative(process.cwd(), localPath)}`)
    }

    console.log('[fsl] Source map upload complete.')
  } catch (err) {
    if (options.embedSourcemaps) {
      console.warn('[fsl] Warning: GCS upload failed — symbolication will work for this release only (via embedded maps). Previous releases will not be symbolicated.')
      console.warn('[fsl] GCS error:', (err as any)?.message ?? err)
      // Delete local .map files even though GCS upload failed — they are embedded and should not be deployed to hosting
      for (const localPath of mapFiles) {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath)
          console.log(`  ✗ deleted ${path.relative(process.cwd(), localPath)}`)
        }
      }
    } else {
      throw err
    }
  }
}
