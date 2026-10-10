/**
 * `fsl upload-sourcemaps --backend`, and `--functions` as a deprecated alias (#24).
 *
 * `--functions` named a Cloud Functions directory, but the same flag also serves a
 * Cloud Run backend — `--backend` is the flag going forward; `--functions` still
 * works, with a one-time deprecation warning (`src/shared/deprecate.ts`).
 *
 * `--embed-sourcemaps` with no `--bucket` needs no network — see #34.
 *
 * Run: npx tsx tests/uploadSourcemapsBackend.ts
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { assert, reportResults } from './testHelpers.js'
import { EMBEDDED_RELEASE_MARKER, uploadSourceMaps } from '../src/tools/uploadSourceMaps.js'

const CLI = path.join(process.cwd(), 'src', 'tools', 'index.ts')

function tempProject(): { root: string; dist: string; backend: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-upload-backend-'))
  const dist = path.join(root, 'dist')
  const backend = path.join(root, 'functions')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'app-abc.js.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }))
  return { root, dist, backend }
}

function runCli(cwd: string, args: string[]): { status: number | null; stderr: string } {
  const out = spawnSync('npx', ['tsx', CLI, 'upload-sourcemaps', ...args], { cwd, encoding: 'utf-8' })
  return { status: out.status, stderr: out.stderr }
}

function testBackendFlagEmbeds() {
  console.log('\nTest: --backend embeds maps into the named directory')
  const { root, backend } = tempProject()
  const out = runCli(root, ['--embed-sourcemaps', '--release=r1', `--backend=${path.relative(root, backend)}`])
  assert('exits cleanly', out.status === 0, out.stderr.slice(0, 300))
  assert(
    'the map was embedded under the backend directory',
    fs.existsSync(path.join(backend, 'sourcemaps', 'current', 'app-abc.js.map')),
  )
  assert('no deprecation warning for --backend', !out.stderr.includes('deprecated'), out.stderr)
  fs.rmSync(root, { recursive: true, force: true })
}

function testFunctionsFlagStillWorksAndWarnsOnce() {
  console.log('\nTest: --functions still works and warns once')
  const { root, backend } = tempProject()
  const out = runCli(root, ['--embed-sourcemaps', '--release=r1', `--functions=${path.relative(root, backend)}`])
  assert('exits cleanly', out.status === 0, out.stderr.slice(0, 300))
  assert(
    'the map was embedded under the backend directory',
    fs.existsSync(path.join(backend, 'sourcemaps', 'current', 'app-abc.js.map')),
  )
  const warnings = out.stderr.split('\n').filter((l) => l.includes('deprecated'))
  assert('exactly one deprecation warning', warnings.length === 1, out.stderr)
  fs.rmSync(root, { recursive: true, force: true })
}

function testEmbedMarksTheReleaseAndClearsWhatWasThere() {
  console.log('\nTest: embedding marks the release and leaves nothing from the previous one')
  const { root, backend } = tempProject()
  const embedded = path.join(backend, 'sourcemaps', 'current')
  fs.mkdirSync(embedded, { recursive: true })
  fs.writeFileSync(path.join(embedded, 'old-bundle.js.map'), '{}')
  fs.writeFileSync(path.join(embedded, EMBEDDED_RELEASE_MARKER), 'r0')
  const out = runCli(root, ['--embed-sourcemaps', '--release=r1', `--backend=${path.relative(root, backend)}`])
  assert('exits cleanly', out.status === 0, out.stderr.slice(0, 300))
  assert(
    'the marker names the new release',
    fs.readFileSync(path.join(embedded, EMBEDDED_RELEASE_MARKER), 'utf-8') === 'r1',
  )
  assert('the previous release map is gone', !fs.existsSync(path.join(embedded, 'old-bundle.js.map')))
  fs.rmSync(root, { recursive: true, force: true })
}

function testEmbedOnlyLeavesNoMapInDist() {
  console.log('\nTest: embed-only deletes the maps from dist/')
  const { root, dist, backend } = tempProject()
  const out = runCli(root, ['--embed-sourcemaps', '--release=r1', `--backend=${path.relative(root, backend)}`])
  assert('exits cleanly', out.status === 0, out.stderr.slice(0, 300))
  assert('no .map file is left in dist/', !fs.existsSync(path.join(dist, 'app-abc.js.map')))
  fs.rmSync(root, { recursive: true, force: true })
}

function mapsLeftIn(dist: string): string[] {
  return fs.readdirSync(dist).filter((f) => f.endsWith('.map'))
}

function testEmbedWithoutBackendIsRefusedAndKeepsTheMaps() {
  console.log('\nTest: --embed-sourcemaps with no --backend exits 1 and leaves every map in dist/')
  const { root, dist } = tempProject()
  const out = runCli(root, ['--embed-sourcemaps', '--release=r1'])
  assert('exits 1', out.status === 1, String(out.status))
  assert('the message names --backend', out.stderr.includes('--backend'), out.stderr)
  assert('the message gives an example', out.stderr.includes('Example:'), out.stderr)
  assert('the message comes without a stack trace', !/^\s+at /m.test(out.stderr), out.stderr)
  assert('every .map is still in dist/', mapsLeftIn(dist).length === 1)
  assert('nothing was embedded', !fs.existsSync(path.join(root, 'functions')))
  fs.rmSync(root, { recursive: true, force: true })
}

function testEmbedWithBucketButNoBackendIsRefusedBeforeAnyUpload() {
  console.log('\nTest: --embed-sourcemaps with a bucket but no --backend exits 1 before any upload')
  const { root, dist } = tempProject()
  const out = runCli(root, ['--embed-sourcemaps', '--release=r1', '--bucket=sentinel-bucket'])
  assert('exits 1', out.status === 1, String(out.status))
  assert('the message names --backend', out.stderr.includes('--backend'), out.stderr)
  assert('no upload was attempted', !out.stderr.includes('GCS'), out.stderr)
  assert('every .map is still in dist/', mapsLeftIn(dist).length === 1)
  fs.rmSync(root, { recursive: true, force: true })
}

async function testProgrammaticEmbedWithoutBackendThrowsAndKeepsTheMaps() {
  console.log('\nTest: uploadSourceMaps() with embedSourcemaps and no functionsDir throws')
  const { root, dist } = tempProject()
  let message = ''
  try {
    await uploadSourceMaps({ embedSourcemaps: true, release: 'r1', distDir: dist })
  } catch (err) {
    message = (err as Error).message
  }
  assert('it throws a message naming --backend', message.includes('--backend'), message)
  assert('every .map is still in dist/', mapsLeftIn(dist).length === 1)
  fs.rmSync(root, { recursive: true, force: true })
}

async function run() {
  testEmbedWithoutBackendIsRefusedAndKeepsTheMaps()
  testEmbedWithBucketButNoBackendIsRefusedBeforeAnyUpload()
  await testProgrammaticEmbedWithoutBackendThrowsAndKeepsTheMaps()
  testEmbedMarksTheReleaseAndClearsWhatWasThere()
  testEmbedOnlyLeavesNoMapInDist()
  testBackendFlagEmbeds()
  testFunctionsFlagStillWorksAndWarnsOnce()
  reportResults()
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
