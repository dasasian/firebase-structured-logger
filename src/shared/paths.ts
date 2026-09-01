/**
 * Every storage location this package reads or writes, defined once.
 *
 * These are contracts, not conveniences: each source-map path has a writer in
 * `/tools` and a reader in `/functions`, and they used to be independent string
 * literals in different entry points with nothing enforcing that they matched.
 * When they disagree, symbolication does not fail — it falls through and returns
 * the minified frames, which looks like "my maps never uploaded".
 *
 * #36 is what that costs: `.release` was written in three places, none of them
 * the writer, so the release check never ran and every stack resolved against
 * whatever happened to be embedded.
 *
 * `/functions` cannot import from `/tools` without a cross-entry-point
 * dependency, which is why this lives in `shared/` beside `error.ts` and
 * `severity.ts` rather than being exported from either side.
 *
 * Cloud Storage object names always use `/`; local paths are built with
 * `path.join` by the caller. The two are kept apart on purpose — a Windows
 * separator in a GCS object name is a different object.
 */

import * as path from 'path'

/** Cloud Storage prefix holding one directory per release. */
export const SOURCEMAP_PREFIX = 'sourcemaps'

/** Cloud Storage prefix holding one directory per log entry. */
export const ATTACHMENT_PREFIX = 'logAttachments'

/**
 * Directory inside the deployed backend holding the current release's maps,
 * relative to the process working directory. Checked before Cloud Storage so
 * the common case costs no network call.
 */
export const EMBEDDED_DIR = path.join(SOURCEMAP_PREFIX, 'current')

/**
 * Names the release the embedded maps belong to.
 *
 * Without it the runtime cannot tell "this stack is from the deployed release"
 * from "this stack is from an older one" — the embedded directory is keyed only
 * by filename, so an old stack naming a bundle that still exists would be
 * resolved with the current map, giving confidently wrong line numbers.
 */
export const RELEASE_MARKER = '.release'

/**
 * Cloud Storage object name for one release's map of one bundle.
 *
 * `bundleFileName` is the bundle as it appears in a stack trace — `app-4f2a.js`,
 * without the `.map`. The suffix belongs to the contract, not to either caller,
 * which is what kept the writer and reader agreeing by accident before.
 */
export function storageMapPath(
  releaseId: string,
  bundleFileName: string,
  prefix: string = SOURCEMAP_PREFIX,
): string {
  return `${trimPrefix(prefix)}/${releaseId}/${bundleFileName}.map`
}

/** Cloud Storage object name for one attachment of one log entry. */
export function attachmentPath(
  logId: string,
  name: string,
  prefix: string = ATTACHMENT_PREFIX,
): string {
  return `${trimPrefix(prefix)}/${logId}/${name}`
}

/**
 * Normalise a caller-supplied prefix.
 *
 * A prefix is a directory, and people write directories with a trailing slash.
 * Passing `'fsl/'` unnormalised yields `fsl//abc/app.js.map`, which is a
 * *different* Storage object from `fsl/abc/app.js.map` — GCS keys are opaque
 * strings, so the double slash is not collapsed and the reader would miss.
 * Leading slashes are dropped for the same reason.
 */
function trimPrefix(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '')
}

/** Local directory holding the embedded maps, under `baseDir`. */
export function embeddedDir(baseDir: string): string {
  return path.join(baseDir, EMBEDDED_DIR)
}

/** Local path of one embedded map, under `baseDir`. */
export function embeddedMapPath(baseDir: string, bundleFileName: string): string {
  return path.join(embeddedDir(baseDir), `${bundleFileName}.map`)
}

/** Local path of the release marker, under `baseDir`. */
export function embeddedMarkerPath(baseDir: string): string {
  return path.join(embeddedDir(baseDir), RELEASE_MARKER)
}

/** Strip the `.map` suffix from a map filename to get the bundle name. */
export function bundleNameOf(mapFileName: string): string {
  return mapFileName.replace(/\.map$/, '')
}
