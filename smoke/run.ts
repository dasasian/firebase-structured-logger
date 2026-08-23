/**
 * Live smoke run.
 *
 * Writes real log entries through deployed Cloud Functions, then queries Cloud
 * Logging and asserts on what came back. This is the only thing that can test
 * the contract nothing else reaches:
 *
 *   our code  ->  stdout JSON      (tests/productionOutput.ts proves this)
 *   stdout    ->  queryable entry  (only observable from deployed compute)
 *
 * Manual, pre-release. Never part of `npm test`.
 *
 *   npm run smoke
 *
 * Config comes from smoke/.env.local — see .env.example. Nothing identifying is
 * committed.
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { Logging } from '@google-cloud/logging'
import { Storage } from '@google-cloud/storage'
import { ulid } from 'ulid'
import type { EncodedSourceMap } from '@jridgewell/trace-mapping'

// --- config ---------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))

function loadEnv(): Record<string, string> {
  const file = path.join(HERE, '.env.local')
  if (!fs.existsSync(file)) {
    console.error('\nsmoke/.env.local not found.')
    console.error('Copy smoke/.env.example and fill it in. Skipping — this is a no-op, not a failure.\n')
    process.exit(0)
  }
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const env = loadEnv()
const PROJECT = env.FSL_SMOKE_PROJECT

// Google bills API calls to the ADC *quota project*, not to the bucket's
// project. If that points somewhere with billing disabled, every write fails
// with "accountDisabled — the billing account for the owning project is
// disabled", which reads as though the smoke project is misconfigured when it
// is not. Set it per-process rather than with
// `gcloud auth application-default set-quota-project`, so whatever the machine
// uses ADC for elsewhere is left alone.
process.env.GOOGLE_CLOUD_QUOTA_PROJECT = PROJECT
process.env.GOOGLE_CLOUD_PROJECT = PROJECT
const BUCKET = env.FSL_SMOKE_BUCKET
const REGION = env.FSL_SMOKE_REGION ?? 'us-central1'
if (!PROJECT || !BUCKET) {
  console.error('FSL_SMOKE_PROJECT and FSL_SMOKE_BUCKET must be set in smoke/.env.local')
  process.exit(1)
}

// Every run is tagged with a fresh id. Without this, a second run would match
// the first run's entries and pass for the wrong reason.
const RUN_ID = ulid()

// Deliberately NOT the deployed release: with no embedded map for this id, the
// lookup must fall through to Storage. That is the old-release path, which is
// the branch nothing else can reach — the embedded path is covered by
// tests/handlerSymbolication.ts with no cloud at all.
const RELEASE_ID = `smoke-${RUN_ID.slice(-8).toLowerCase()}`
const BUNDLE = 'app-SMOKE01.js'

// col 4 -> catalogProducts.ts:10:2 "duplicate"
const SOURCE_MAP: EncodedSourceMap = {
  version: 3,
  sources: ['../../src/services/catalogProducts.ts'],
  names: ['duplicate', 'handleCreate'],
  mappings: 'IASEA,cAeFC',
}

// --- assertions -----------------------------------------------------------

let passed = 0
let failed = 0
function assert(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`)
    failed++
  }
}

// --- helpers --------------------------------------------------------------

const storage = new Storage({ projectId: PROJECT })
const logging = new Logging({ projectId: PROJECT })

function functionUrl(name: string): string {
  return `https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`
}

async function callFunction(name: string, data: unknown): Promise<void> {
  const res = await fetch(functionUrl(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  if (!res.ok) {
    throw new Error(`${name} returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
}

/**
 * Poll until `want` entries carrying this run id appear, or time out.
 *
 * The query is deliberately BROAD — it matches on the run id in the text
 * payload, not on labels. If it filtered on labels and returned nothing, we
 * could not tell "labels were not promoted to entry labels" from "nothing was
 * logged at all". The label filter is asserted separately, as a result.
 */
async function waitForEntries(want: number, timeoutMs = 120_000): Promise<any[]> {
  const started = Date.now()
  let last: any[] = []
  let delay = 3_000
  while (Date.now() - started < timeoutMs) {
    const [entries] = await logging.getEntries({
      resourceNames: [`projects/${PROJECT}`],
      filter: `timestamp >= "${new Date(started - 300_000).toISOString()}"`,
      orderBy: 'timestamp desc',
      pageSize: 200,
    })
    // Search the payload AND the entry labels. Once labels are promoted to
    // LogEntry.labels they are no longer inside `data`, so a payload-only match
    // silently misses every entry whose run id rode in a label — which is most
    // of them.
    const mine = entries.filter(
      (e) =>
        JSON.stringify(e.data ?? {}).includes(RUN_ID) ||
        JSON.stringify(e.metadata?.labels ?? {}).includes(RUN_ID),
    )
    process.stdout.write(`\r  … ${mine.length}/${want} entries after ${Math.round((Date.now() - started) / 1000)}s   `)
    if (mine.length >= want) {
      process.stdout.write('\n')
      return mine
    }
    last = mine
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 1.4, 15_000)
  }
  process.stdout.write('\n')
  // Return whatever arrived rather than nothing: a partial result still tells
  // you which entries are missing, where an empty array tells you nothing.
  if (last.length) console.log(`  timed out with ${last.length}/${want} — asserting on what arrived`)
  return last
}

/** Does a narrow label filter find this run? This is the queryability claim. */
async function queryByLabel(field: string, value: string): Promise<number> {
  const [entries] = await logging.getEntries({
    resourceNames: [`projects/${PROJECT}`],
    filter: `labels.${field}="${value}"`,
    pageSize: 50,
  })
  return entries.length
}

// --- the run --------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\nSmoke run ${RUN_ID}`)
  console.log(`  project ${PROJECT}  ·  release ${RELEASE_ID}\n`)

  // 1. Put a source map in Storage under a release that has no embedded copy,
  //    so symbolication has to use the Storage path.
  const objectPath = `sourcemaps/${RELEASE_ID}/${BUNDLE}.map`
  await storage.bucket(BUCKET).file(objectPath).save(JSON.stringify(SOURCE_MAP))
  console.log(`  uploaded gs://${BUCKET}/${objectPath}`)

  // 2. Client path: a minified stack that can only resolve via that map.
  const minified = `duplicate@https://app.example.com/assets/${BUNDLE}:1:4`
  await callFunction('fslSmokeClient', {
    message: `[fsl-verify] client error ${RUN_ID}`,
    severity: 'ERROR',
    labels: { appId: env.FSL_SMOKE_APP_ID ?? 'smoke-app', releaseId: RELEASE_ID, errorType: 'fsl-verify', smokeRunId: RUN_ID, screen: 'SmokeScreen' },
    jsonPayload: {
      error: { message: `[fsl-verify] client error ${RUN_ID}`, name: 'Error', stack: minified },
      context: { runId: RUN_ID },
      breadcrumbs: [{ timestamp: Date.now(), type: 'action', name: 'smoke_action' }],
    },
    attachments: { note: Buffer.from(`smoke ${RUN_ID}`).toString('base64') },
  })
  console.log('  invoked fslSmokeClient')

  // 3. Backend path: initRequestLogger + AsyncLocalStorage.
  await callFunction('fslSmokeBackend', { runId: RUN_ID })
  console.log('  invoked fslSmokeBackend\n')

  // 4. Wait for ingestion. 1 client entry + 3 backend entries.
  const entries = await waitForEntries(4)
  if (entries.length === 0) {
    console.error('\n  No entries arrived within the timeout. Nothing further can be asserted.')
    failed++
    return
  }

  const payloads = entries.map((e) => ({ data: e.data as any, meta: e.metadata as any }))
  const client = payloads.find((p) => String(p.data?.message ?? '').includes('client error'))
  const backendInfo = payloads.find((p) => String(p.data?.message ?? '').includes('backend info'))

  console.log('\n  --- entry shape ---')
  assert('the client entry arrived', !!client)
  assert('the backend entry arrived', !!backendInfo)

  const labels = client?.meta?.labels ?? {}
  assert('labels are ENTRY labels, not nested in the payload', Object.keys(labels).length > 0,
    `entry labels: ${JSON.stringify(labels)}`)
  assert('appId is an entry label', !!labels.appId, `got: ${JSON.stringify(labels)}`)
  assert('releaseId is an entry label', labels.releaseId === RELEASE_ID, `got: ${labels.releaseId}`)
  assert('errorType is an entry label', labels.errorType === 'fsl-verify', `got: ${labels.errorType}`)
  assert('screen is an entry label', labels.screen === 'SmokeScreen', `got: ${labels.screen}`)
  assert('a logId was assigned', typeof labels.logId === 'string' && labels.logId.length === 26, `got: ${labels.logId}`)
  assert('hasAttachments is flagged', labels.hasAttachments === 'true', `got: ${labels.hasAttachments}`)
  assert('severity is the entry severity', client?.meta?.severity === 'ERROR', `got: ${client?.meta?.severity}`)

  assert('breadcrumbs survived the trip', Array.isArray(client?.data?.breadcrumbs), `got: ${JSON.stringify(client?.data?.breadcrumbs)}`)
  assert('context survived the trip', client?.data?.context?.runId === RUN_ID)
  assert('jsonPayload was spread, not nested', !('jsonPayload' in (client?.data ?? {})),
    `keys: ${Object.keys(client?.data ?? {}).join(', ')}`)

  console.log('\n  --- symbolication via Storage (the old-release path) ---')
  const stack: string = client?.data?.error?.stack ?? ''
  assert('the bundle URL is gone', !stack.includes(BUNDLE), `got: ${stack}`)
  assert('the source file is named', stack.includes('catalogProducts.ts'), `got: ${stack}`)

  console.log('\n  --- the attachment reached GCS at the logId path ---')
  if (labels.logId) {
    const [exists] = await storage.bucket(BUCKET).file(`logAttachments/${labels.logId}/note`).exists()
    assert('the object exists where the label says it should', exists,
      `looked for logAttachments/${labels.logId}/note`)
  }

  console.log('\n  --- queryability: the product promise ---')
  assert('filtering by labels.smokeRunId finds this run', (await queryByLabel('smokeRunId', RUN_ID)) > 0)
  assert('filtering by labels.releaseId isolates the release', (await queryByLabel('releaseId', RELEASE_ID)) > 0)
  assert('filtering by labels.errorType finds the entries', (await queryByLabel('errorType', 'fsl-verify')) > 0)

  console.log('\n  --- backend path ---')
  const bLabels = backendInfo?.meta?.labels ?? {}
  assert('functionName is set by initRequestLogger', bLabels.functionName === 'fslSmokeBackend', `got: ${bLabels.functionName}`)
  assert('the run id rode through AsyncLocalStorage', bLabels.smokeRunId === RUN_ID, `got: ${bLabels.smokeRunId}`)
}

async function cleanup(): Promise<void> {
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: `sourcemaps/${RELEASE_ID}/` })
  for (const f of files) await f.delete().catch(() => {})
  if (files.length) console.log(`\n  cleaned up ${files.length} source map object(s)`)
}

main()
  .catch((err) => {
    console.error('\nFatal:', err instanceof Error ? err.message : err)
    failed++
  })
  .then(cleanup)
  .catch(() => {})
  .finally(() => {
    console.log(`\n${'─'.repeat(40)}`)
    console.log(`Results: ${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
