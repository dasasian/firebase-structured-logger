/**
 * Install smoke: the packed tarball, installed the way a Cloud Run service would.
 *
 * `/functions` has to load on a backend with no `firebase-functions` — that is the
 * backend `createHttpLogHandler` is for. Nothing in `npm test` can prove it, because
 * this repo has the package in devDependencies, so it is always resolvable here.
 * `tests/loadsWithoutFirebaseFunctions` checks the source for the shape that broke it;
 * this checks the thing a user actually gets.
 *
 * It builds, packs, installs the tarball into an empty temp directory (optional peers
 * are not installed, so `firebase-functions` is absent), then loads `/functions` from
 * both CommonJS and ESM and sends one ERROR through `createHttpLogHandler`.
 *
 * Needs the npm registry for the package's own dependencies, nothing else — no cloud,
 * no credentials.
 *
 *   npm run smoke:install
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { assert, reportResults } from '../tests/testHelpers.js'
import { findPackageCopies } from '../src/shared/nodeModules.js'

const repo = process.cwd()
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-install-'))

function npm(args: string[], cwd: string): string {
  return execFileSync('npm', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// The probe runs inside the install. It writes the handler's status on stdout and
// leaves the log entry on stderr (ERROR goes there), so the two never mix.
const PROBE_BODY = `
fsl.initLogger({ appId: 'install-smoke', minSeverity: 'DEBUG' })

let createClientLogFunctionError = null
try { fsl.createClientLogFunction({}) } catch (e) { createClientLogFunctionError = e.code ?? e.message }

const handler = fsl.createHttpLogHandler({ authorize: 'unauthenticated' })
const res = {
  statusCode: 0,
  setHeader() {},
  end() { process.stdout.write(JSON.stringify({ status: res.statusCode, createClientLogFunctionError }) + '\\n') },
}
handler({
  method: 'POST',
  headers: { 'x-cloud-trace-context': '0123456789abcdef0123456789abcdef/1;o=1' },
  body: {
    message: 'install smoke',
    severity: 'ERROR',
    labels: { appId: 'install-smoke', releaseId: 'r1', userId: 'u1' },
    jsonPayload: { error: { message: 'boom', name: 'Error', stack: 'Error: boom\\n    at probe (probe.js:1:1)' } },
  },
}, res)
`

const PROBES: Record<string, string> = {
  'probe.cjs': `const fsl = require('@dasasian/firebase-structured-logger/functions')\n${PROBE_BODY}`,
  'probe.mjs': `import fsl from '@dasasian/firebase-structured-logger/functions'\n${PROBE_BODY}`,
}

/** Every installed copy of @google-cloud/storage under `dir`, by version. */
function storageCopies(dir: string): string[] {
  return findPackageCopies(dir, '@google-cloud/storage').map((c) => c.version)
}

const STORAGE_PROBE = `
const fsl = require('@dasasian/firebase-structured-logger/functions')
fsl.initLogger({ appId: 'install-smoke', minSeverity: 'DEBUG' })
fsl.configureAttachments({ bucket: 'install-smoke-bucket' })
const handler = fsl.createHttpLogHandler({ authorize: 'unauthenticated' })
const res = { statusCode: 0, setHeader() {}, end() {} }
handler({
  method: 'POST',
  headers: {},
  body: {
    message: 'storage smoke', severity: 'ERROR', labels: { appId: 'install-smoke' },
    attachments: { note: Buffer.from('hi').toString('base64') },
  },
}, res)
// The upload is async and fails on the closed port; give it time to say so.
setTimeout(() => {}, 5000)
`

interface ProbeResult {
  status: number
  createClientLogFunctionError: string | null
}

interface EmittedEntry {
  severity?: string
  message?: string
  stack_trace?: string
  serviceContext?: { service?: string; version?: string }
  'logging.googleapis.com/labels'?: Record<string, string>
  'logging.googleapis.com/trace'?: string
}

function run() {
  try {
    console.log('\nSetup: build, pack, install into an empty directory')
    npm(['run', 'clean'], repo)
    npm(['run', 'build'], repo)
    const tarball = npm(['pack', '--pack-destination', work, '--silent'], repo).trim().split('\n').pop()!
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ private: true }))
    npm(['install', '--no-audit', '--no-fund', path.join(work, tarball)], work)

    assert(
      'firebase-functions is not installed',
      !fs.existsSync(path.join(work, 'node_modules', 'firebase-functions')),
    )

    for (const [file, source] of Object.entries(PROBES)) {
      console.log(`\nTest: ${file} loads /functions and logs through createHttpLogHandler`)
      fs.writeFileSync(path.join(work, file), source)
      const out = spawnSync('node', [file], { cwd: work, encoding: 'utf-8' })

      assert('it exits cleanly', out.status === 0, out.stderr.slice(0, 500))
      if (out.status !== 0) continue

      const result = JSON.parse(out.stdout.trim().split('\n').pop()!) as ProbeResult
      assert('the handler answers 204', result.status === 204, `got ${result.status}`)
      assert(
        'createClientLogFunction fails only when called, as MODULE_NOT_FOUND',
        result.createClientLogFunctionError === 'MODULE_NOT_FOUND',
        String(result.createClientLogFunctionError),
      )

      const entries = out.stderr
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as EmittedEntry)
      const entry = entries.find((e) => e.message === 'install smoke')
      assert('the ERROR entry is on stderr, as one JSON line', entry !== undefined, out.stderr.slice(0, 500))
      if (!entry) continue

      assert('severity is ERROR', entry.severity === 'ERROR')
      assert('labels are under the promoted key', entry['logging.googleapis.com/labels']?.userId === 'u1')
      assert(
        'the trace comes from the request header',
        entry['logging.googleapis.com/trace'] === '0123456789abcdef0123456789abcdef',
      )
      assert('stack_trace is present', typeof entry.stack_trace === 'string')
      assert(
        'serviceContext names the app and release',
        entry.serviceContext?.service === 'install-smoke' && entry.serviceContext.version === 'r1',
      )
    }

    // Both Storage majors, really used. The package accepts `^7.19.0 || ^8.1.0` so
    // that npm reuses whichever copy the user's firebase-admin already brought
    // (13.x → 7, 14.5+ → 8) instead of installing a second. So each major has to
    // work, not merely load: with a bucket named and no firebase-admin, an
    // attachment goes through @google-cloud/storage (step 2 of the Storage chain).
    // The emulator host is a closed local port, so the upload fails fast and its
    // warning proves the request was built — nothing reaches real Storage.
    for (const major of ['7', '8']) {
      console.log(`\nTest: with @google-cloud/storage ${major}, an attachment goes through it`)
      npm(['install', '--no-audit', '--no-fund', `@google-cloud/storage@${major}`], work)
      const installed = JSON.parse(
        fs.readFileSync(path.join(work, 'node_modules', '@google-cloud', 'storage', 'package.json'), 'utf-8'),
      ) as { version: string }
      assert(`Storage ${major}.x is the one installed`, installed.version.startsWith(`${major}.`), installed.version)
      const nested = path.join(work, 'node_modules', '@dasasian', 'firebase-structured-logger', 'node_modules', '@google-cloud', 'storage')
      assert('there is one copy, not a second one under the package', !fs.existsSync(nested))

      fs.writeFileSync(path.join(work, 'storage.cjs'), STORAGE_PROBE)
      const out = spawnSync('node', ['storage.cjs'], {
        cwd: work,
        encoding: 'utf-8',
        env: { ...process.env, STORAGE_EMULATOR_HOST: 'http://127.0.0.1:9' },
        timeout: 60_000,
      })
      assert('it exits cleanly', out.status === 0, out.stderr.slice(0, 500))
      assert(
        'the upload was built by Storage and aimed at the attachment path',
        out.stderr.includes('Log attachment upload failed') && out.stderr.includes('logAttachments'),
        out.stderr.slice(0, 600),
      )
    }

    // A user's real install, not a pinned one: firebase-admin 13 and this package in
    // one command. npm picks the newest Storage it can for us (8) before it sees that
    // firebase-admin 13 needs 7, so this gives two copies — measured, and documented
    // in the README with its fix. What must hold is that `npm dedupe` folds them into one.
    console.log('\nTest: firebase-admin 13 installed alongside — npm dedupe leaves one Storage')
    const project = path.join(work, 'with-firebase-admin-13')
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true }))
    npm(['install', '--no-audit', '--no-fund', 'firebase-admin@13', path.join(work, tarball)], project)
    const before = storageCopies(project)
    console.log(`  (installed together: ${before.join(', ')})`)

    const doctorBin = path.join(project, 'node_modules', '@dasasian', 'firebase-structured-logger', 'dist', 'tools', 'index.js')
    const doctorJson = (cwd: string): { findings: Array<{ id: string }> } => {
      const out = execFileSync('node', [doctorBin, 'doctor', '--backend=.', '--json'], { cwd, encoding: 'utf-8' })
      return JSON.parse(out.trim().split('\n').pop()!)
    }

    const beforeReport = doctorJson(project)
    assert(
      'fsl doctor --json reports duplicate-storage before dedupe',
      beforeReport.findings.some((f) => f.id === 'duplicate-storage'),
      JSON.stringify(beforeReport.findings),
    )

    npm(['dedupe', '--no-audit', '--no-fund'], project)
    const after = storageCopies(project)
    assert('after npm dedupe there is exactly one copy of Storage', after.length === 1, after.join(', '))
    assert('and it is the 7.x firebase-admin 13 needs', after[0]?.startsWith('7.'), after.join(', '))

    const afterReport = doctorJson(project)
    assert(
      'fsl doctor --json does not report duplicate-storage after dedupe',
      !afterReport.findings.some((f) => f.id === 'duplicate-storage'),
      JSON.stringify(afterReport.findings),
    )
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  reportResults()
}

run()
