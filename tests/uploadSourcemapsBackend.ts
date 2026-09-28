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

function run() {
  testBackendFlagEmbeds()
  testFunctionsFlagStillWorksAndWarnsOnce()
  reportResults()
}

run()
