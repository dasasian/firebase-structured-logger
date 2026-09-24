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
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
  reportResults()
}

run()
