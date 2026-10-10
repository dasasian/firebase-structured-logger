import * as fs from 'fs'
import * as path from 'path'
import { Storage } from '@google-cloud/storage'
import { RELEASE_MARKER, bundleNameOf, embeddedDir, storageMapPath } from '../shared/paths.js'

/**
 * Exit code used when maps were embedded but the Storage upload failed.
 *
 * Distinct from 1 so a deploy script can decide: `|| [ $? -eq 3 ]` to continue
 * anyway, or let it stop the chain. Exiting 0 was too quiet — the deploy script
 * is a `&&` chain, so the deploy proceeded and the only signal was a warning
 * scrolling past in CI output.
 */
export const EXIT_UPLOAD_FAILED_BUT_EMBEDDED = 3

/**
 * Records which release the embedded maps belong to.
 *
 * Without it the runtime cannot tell "this stack is from the deployed release"
 * from "this stack is from an older one" — the embedded directory is keyed only
 * by filename, so an old stack naming a bundle that still exists would be
 * resolved with the current map, giving confidently wrong line numbers.
 */
export const EMBEDDED_RELEASE_MARKER = RELEASE_MARKER

export interface UploadOptions {
  /**
   * Cloud Storage bucket to upload to. Resolved by the caller — the CLI falls
   * back to env vars.
   *
   * Optional, but only alongside `embedSourcemaps`: a run that neither uploads
   * nor embeds does nothing except delete maps, which is not a thing to let
   * someone ask for by accident. Omitting it is how a backend with no bucket —
   * Cloud Run, say — gets the embedded copy without inventing a bucket name to
   * satisfy the tool (#34).
   */
  bucket?: string
  release?: string
  distDir?: string
  /**
   * Path to the backend directory (e.g. './functions' or './backend').
   *
   * Named `functionsDir` internally; the CLI flag is `--backend` (`--functions` is
   * kept as a deprecated alias) — this option also serves a Cloud Run backend that
   * is not a Cloud Functions directory at all.
   */
  functionsDir?: string
  embedSourcemaps?: boolean  // copy maps to {functionsDir}/sourcemaps/current/ (default false)
  /**
   * Cloud Storage prefix to upload under. Defaults to `sourcemaps/`.
   *
   * The reader must be told the same value, via
   * `createClientLogHandler({ sourceMaps: { prefix } })`. These are the two ends
   * of one contract and nothing checks them against each other — when they
   * disagree the maps are simply not found and stacks stay minified, which
   * looks identical to never having uploaded them (#35).
   *
   * Does not affect the embedded copy: that directory ships inside the deploy
   * artifact and nothing outside reads it, so it stays fixed.
   */
  prefix?: string
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

function embedMapsForCurrentRelease(mapFiles: string[], functionsDir: string, releaseId: string): void {
  const embedDir = embeddedDir(path.join(process.cwd(), functionsDir))
  fs.mkdirSync(embedDir, { recursive: true })
  for (const f of fs.readdirSync(embedDir)) {
    fs.unlinkSync(path.join(embedDir, f))
  }
  for (const localPath of mapFiles) {
    const dest = path.join(embedDir, path.basename(localPath))
    const { json, before, after } = readStrippedMap(localPath)
    fs.writeFileSync(dest, json)
    const saved = before > after ? ` (${kb(before)} → ${kb(after)})` : ''
    console.log(`  ✓ embedded ${path.basename(localPath)} → ${functionsDir}/sourcemaps/current/${saved}`)
  }

  fs.writeFileSync(path.join(embedDir, EMBEDDED_RELEASE_MARKER), releaseId)
  console.log(`  ✓ marked ${functionsDir}/sourcemaps/current/ as release ${releaseId}`)
}

function removeMapsBrowsersCouldServe(mapFiles: string[]): void {
  for (const localPath of mapFiles) {
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath)
      console.log(`  ✗ deleted ${path.relative(process.cwd(), localPath)}`)
    }
  }
}

function keyFileOrApplicationDefaultCredentials(): { keyFilename?: string } {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  return serviceAccountPath && fs.existsSync(serviceAccountPath) ? { keyFilename: serviceAccountPath } : {}
}

function warnThisReleaseHasOnlyTheEmbeddedCopy(releaseId: string, err: unknown): void {
  console.warn(`[fsl] GCS upload FAILED for release ${releaseId}.`)
  console.warn('[fsl] GCS error:', (err as Error)?.message ?? err)
  console.warn(`[fsl] Errors from ${releaseId} will still symbolicate while it is the deployed`)
  console.warn('[fsl]   release, because the embedded copy is checked first. Once a newer release')
  console.warn(`[fsl]   is deployed, sourcemaps/current/ is replaced and ${releaseId} can no`)
  console.warn('[fsl]   longer be symbolicated. Re-run upload-sourcemaps before deploying again.')
}

/**
 * Upload every `.map` under `distDir` to Storage and/or embed it into the backend, then
 * delete it from `distDir` so no source map is served to browsers.
 *
 * If the upload fails and `embedSourcemaps` is set, resolves `{ uploaded: false }` instead
 * of throwing. Earlier releases are unaffected, since their maps reached Storage on earlier
 * runs; only this release is at risk, because its maps exist only in
 * `{functionsDir}/sourcemaps/current/`, which the next deploy wipes.
 */
export async function uploadSourceMaps(options: UploadOptions): Promise<{ uploaded: boolean }> {
  const releaseId = options.release ?? process.env.VITE_RELEASE_ID ?? process.env.RELEASE_ID
  if (!releaseId) {
    console.error('[fsl] Release ID required. Set RELEASE_ID (or VITE_RELEASE_ID) in .env.local or pass --release=<id>.')
    process.exit(1)
  }
  const distDir = options.distDir ?? path.join(process.cwd(), 'dist')
  const mapFiles = findMapFiles(distDir)

  if (!options.bucket && !options.embedSourcemaps) {
    throw new Error(
      '[fsl] Nothing to do: no --bucket to upload to and no --embed-sourcemaps. ' +
        'Running would only delete the maps from dist/.',
    )
  }

  if (options.embedSourcemaps && !options.functionsDir) {
    throw new Error(
      '[fsl] --embed-sourcemaps needs --backend=<path> to say where to embed the maps. ' +
        'Example: fsl upload-sourcemaps --embed-sourcemaps --backend=./functions',
    )
  }

  if (mapFiles.length === 0) {
    console.log('[fsl] No .map files found in', distDir)
    return { uploaded: true }
  }

  const verb = options.bucket ? 'Uploading' : 'Embedding'
  console.log(`[fsl] ${verb} ${mapFiles.length} source map(s) for release ${releaseId}...`)

  if (options.embedSourcemaps && options.functionsDir) {
    embedMapsForCurrentRelease(mapFiles, options.functionsDir, releaseId)
  }

  if (!options.bucket) {
    removeMapsBrowsersCouldServe(mapFiles)
    console.log('[fsl] Embedded only — no bucket given, nothing uploaded.')
    console.log(`[fsl]   Stacks from ${releaseId} symbolicate while it is the deployed release.`)
    console.log('[fsl]   Older releases cannot be symbolicated without a bucket to read from.')
    return { uploaded: true }
  }

  const storage = new Storage(keyFileOrApplicationDefaultCredentials())
  const bucket = storage.bucket(options.bucket)

  try {
    for (const localPath of mapFiles) {
      const fileName = path.basename(localPath)
      const destination = storageMapPath(releaseId, bundleNameOf(fileName), options.prefix)

      const { json, before, after } = readStrippedMap(localPath)
      await bucket.file(destination).save(json, { contentType: 'application/json' })
      const saved = before > after ? ` (${kb(before)} → ${kb(after)}, -${Math.round(100 - (after / before) * 100)}%)` : ''
      console.log(`  ✓ ${fileName} → gs://${options.bucket}/${destination}${saved}`)

      fs.unlinkSync(localPath)
      console.log(`  ✗ deleted ${path.relative(process.cwd(), localPath)}`)
    }

    console.log('[fsl] Source map upload complete.')
    return { uploaded: true }
  } catch (err) {
    if (!options.embedSourcemaps) throw err

    warnThisReleaseHasOnlyTheEmbeddedCopy(releaseId, err)
    removeMapsBrowsersCouldServe(mapFiles)
    return { uploaded: false }
  }
}
