/**
 * The storage path contracts (#35).
 *
 * Each source-map path has a writer in `/tools` and a reader in `/functions`.
 * They used to be independent string literals in different entry points, and
 * nothing asserted they matched — when they disagree symbolication does not
 * fail, it returns the minified frames, which reads as "my maps never
 * uploaded". #36 is what that costs in practice.
 *
 * These tests exist so a change to one side cannot silently pass.
 *
 *   npx tsx tests/paths.ts
 */

import * as path from 'path'
import {
  ATTACHMENT_PREFIX,
  EMBEDDED_DIR,
  RELEASE_MARKER,
  SOURCEMAP_PREFIX,
  attachmentPath,
  bundleNameOf,
  embeddedDir,
  embeddedMapPath,
  embeddedMarkerPath,
  storageMapPath,
} from '../src/shared/paths.js'
import { EMBEDDED_RELEASE_MARKER } from '../src/tools/uploadSourceMaps.js'
import { assert, reportResults } from './testHelpers.js'

/**
 * The writer holds a map filename from disk (`app-4f2a.js.map`); the reader
 * holds a bundle name from a stack trace (`app-4f2a.js`). The `.map` suffix
 * belongs to the contract so neither side owns it — before, the two agreed
 * only because the writer's basename happened to end in `.map` already.
 */
function testWriterAndReaderResolveTheSameObject() {
  console.log('\nTest: the writer stores where the reader looks')

  const release = 'abc1234'
  const onDisk = 'app-4f2a.js.map'
  const fromStack = 'app-4f2a.js'

  assert('the map filename reduces to the bundle name', bundleNameOf(onDisk) === fromStack, `got: ${bundleNameOf(onDisk)}`)
  assert(
    'both sides name one object',
    storageMapPath(release, bundleNameOf(onDisk)) === storageMapPath(release, fromStack),
  )
  assert(
    'and it is the documented path',
    storageMapPath(release, fromStack) === 'sourcemaps/abc1234/app-4f2a.js.map',
    storageMapPath(release, fromStack),
  )
}

/**
 * A bundle already ending in `.map` would otherwise lose its suffix. Vite does
 * not produce one, but the rule should be "strip one trailing .map", not
 * "remove .map wherever it appears".
 */
function testOnlyTheTrailingSuffixIsStripped() {
  console.log('\nTest: bundleNameOf strips one trailing suffix, not any occurrence')

  assert('an inner .map survives', bundleNameOf('vendor.map.js.map') === 'vendor.map.js', bundleNameOf('vendor.map.js.map'))
  assert('a name without the suffix is unchanged', bundleNameOf('app-4f2a.js') === 'app-4f2a.js')
}

/**
 * Cloud Storage object names are `/`-separated on every platform. Building one
 * with `path.join` yields a different object on Windows, silently.
 */
function testStorageNamesAreNotPlatformPaths() {
  console.log('\nTest: Storage object names use forward slashes only')

  assert('no separator leaks into the map path', !storageMapPath('r1', 'app.js').includes('\\'))
  assert('no separator leaks into the attachment path', !attachmentPath('01J', 'shot.png').includes('\\'))
  assert(
    'attachments land under the documented prefix',
    attachmentPath('01JABC', 'screenshot.png') === 'logAttachments/01JABC/screenshot.png',
    attachmentPath('01JABC', 'screenshot.png'),
  )
  assert('the prefixes are the documented ones', SOURCEMAP_PREFIX === 'sourcemaps' && ATTACHMENT_PREFIX === 'logAttachments')
}

/**
 * The marker names the release the embedded maps belong to, so it has to live
 * beside them. In a different directory it is never found and the release check
 * silently stops running — which is exactly the #36 failure, by another route.
 */
function testTheMarkerSitsWithTheMapsItDescribes() {
  console.log('\nTest: the marker lives in the embedded directory')

  const base = path.join('/srv', 'functions')
  assert('the marker is inside the embedded directory', embeddedMarkerPath(base).startsWith(embeddedDir(base) + path.sep))
  assert('and is named by the contract', path.basename(embeddedMarkerPath(base)) === RELEASE_MARKER)
  assert('maps are in the same directory', path.dirname(embeddedMapPath(base, 'app.js')) === embeddedDir(base))
  assert('the embedded map keeps the .map suffix', path.basename(embeddedMapPath(base, 'app.js')) === 'app.js.map')
  assert('the embedded directory is the current release, under the map prefix', EMBEDDED_DIR === path.join('sourcemaps', 'current'))
}

/**
 * `EMBEDDED_RELEASE_MARKER` is public API on the `/tools` entry point. It must
 * stay the value the reader looks for, or a consumer reading the marker
 * themselves would look in the wrong place.
 */
function testThePublicConstantStillNamesTheContract() {
  console.log('\nTest: the exported constant tracks the contract')

  assert('the /tools export equals the shared value', EMBEDDED_RELEASE_MARKER === RELEASE_MARKER, EMBEDDED_RELEASE_MARKER)
}

/**
 * The failure #35 exists to prevent. `fsl upload-sourcemaps --prefix=X` and
 * `createClientLogHandler({ sourceMaps: { prefix: X } })` are the two ends of one
 * contract, and nothing checks them against each other at runtime — when they
 * disagree the map is simply not found and the stack stays minified, which
 * reads as "the upload never happened".
 *
 * They agree structurally now because both go through this one builder. This
 * test is what keeps that true.
 */
function testACustomPrefixAgreesOnBothSides() {
  console.log('\nTest: a non-default prefix resolves the same for writer and reader')

  const written = storageMapPath('r7', bundleNameOf('app-9f.js.map'), 'fsl-maps')
  const read = storageMapPath('r7', 'app-9f.js', 'fsl-maps')
  assert('both ends name one object', written === read, `${written} vs ${read}`)
  assert('under the given prefix', written === 'fsl-maps/r7/app-9f.js.map', written)
  assert('and not the default one', !written.startsWith('sourcemaps/'))

  assert(
    'attachments take a prefix too',
    attachmentPath('01J', 'shot.png', 'evidence') === 'evidence/01J/shot.png',
    attachmentPath('01J', 'shot.png', 'evidence'),
  )
}

/**
 * A prefix is a directory, and people write directories with a trailing slash.
 * Unnormalised, `'fsl/'` yields `fsl//r7/app.js.map` — a DIFFERENT Storage
 * object from `fsl/r7/app.js.map`, because GCS keys are opaque strings and the
 * double slash is not collapsed. The writer and reader would then disagree over
 * nothing but a typo.
 */
function testPrefixesAreNormalised() {
  console.log('\nTest: slashes around a prefix do not change the object')

  const plain = storageMapPath('r7', 'app.js', 'fsl')
  assert('a trailing slash is ignored', storageMapPath('r7', 'app.js', 'fsl/') === plain, storageMapPath('r7', 'app.js', 'fsl/'))
  assert('a leading slash is ignored', storageMapPath('r7', 'app.js', '/fsl') === plain, storageMapPath('r7', 'app.js', '/fsl'))
  assert('both at once', storageMapPath('r7', 'app.js', '/fsl/') === plain)
  assert('nested prefixes survive', storageMapPath('r7', 'app.js', 'team/fsl/') === 'team/fsl/r7/app.js.map')
  assert('attachments normalise the same way', attachmentPath('01J', 'a.png', '/e/') === attachmentPath('01J', 'a.png', 'e'))
}

testWriterAndReaderResolveTheSameObject()
testACustomPrefixAgreesOnBothSides()
testPrefixesAreNormalised()
testOnlyTheTrailingSuffixIsStripped()
testStorageNamesAreNotPlatformPaths()
testTheMarkerSitsWithTheMapsItDescribes()
testThePublicConstantStillNamesTheContract()
reportResults()
