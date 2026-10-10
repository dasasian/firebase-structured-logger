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
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { Logging } from '@google-cloud/logging'
import { GoogleAuth } from 'google-auth-library'
import { Storage } from '@google-cloud/storage'
import { ulid } from 'ulid'
import type { EncodedSourceMap } from '@jridgewell/trace-mapping'
import { runDoctor } from '../src/tools/doctor.js'

// --- config ---------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

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

// The deployed function ships embedded maps for this release (see
// smoke/functions/sourcemaps/current/). RELEASE_ID above is deliberately NOT
// this, so a stack tagged with it exercises the release-mismatch path: embedded
// is skipped, Storage is consulted, and the correct map wins.
const EMBEDDED_RELEASE = 'smoke-embedded'
const EMBEDDED_BUNDLE = 'app-EMBEDDED.js'

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

interface CallerAnswer {
  httpStatus: number
  errorStatus?: string
  errorMessage?: string
}

async function callFunctionForAnswer(name: string, data: unknown): Promise<CallerAnswer> {
  const res = await fetch(functionUrl(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: { status?: string; message?: string } }
  return { httpStatus: res.status, errorStatus: body.error?.status, errorMessage: body.error?.message }
}

/**
 * Poll until `want` entries carrying this run id appear, or time out.
 *
 * The query is deliberately BROAD — it matches on the run id in the text
 * payload, not on labels. If it filtered on labels and returned nothing, we
 * could not tell "labels were not promoted to entry labels" from "nothing was
 * logged at all". The label filter is asserted separately, as a result.
 */
/**
 * What a log entry looks like to this harness.
 *
 * Written out rather than left as `any` because `any` is what let
 * `entry.metadata.errorGroups` through — a field the client library does not
 * surface at all, which cost a full deploy-and-wait cycle and a wrong conclusion
 * about whether Error Reporting had grouped anything (#38).
 *
 * `errorGroups` is declared here precisely because the client's own `LogEntry`
 * type omits it. That omission is the reason entries are read over REST.
 */
interface SmokeEntryData {
  message?: string
  stack_trace?: string
  serviceContext?: { service?: string; version?: string }
  error?: { message?: string; name?: string; stack?: string; cause?: string }
  breadcrumbs?: Array<{ type: string; name: string }>
  context?: Record<string, unknown>
  [key: string]: unknown
}

interface SmokeEntryMeta {
  severity?: string
  labels?: Record<string, string | undefined>
  trace?: string
  timestamp?: string
  textPayload?: string
  errorGroups?: Array<{ id?: string }>
  [key: string]: unknown
}

interface SmokeEntry {
  data?: SmokeEntryData
  metadata?: SmokeEntryMeta
  errorGroups?: Array<{ id?: string }>
}

/**
 * Poll until `want` entries of this run have arrived — and, when given, until
 * `ready` agrees. A count alone is not enough: other lines can carry the run id
 * (a platform or [fsl] line), so the count can be met while an entry the
 * assertions need is still in ingestion.
 */
async function waitForEntries(
  want: number,
  timeoutMs = 240_000,
  ready: (entries: SmokeEntry[]) => boolean = () => true,
): Promise<SmokeEntry[]> {
  const started = Date.now()
  let last: SmokeEntry[] = []
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
    // The client library's Entry carries everything read here EXCEPT
    // `errorGroups`, which its LogEntry type omits entirely — see
    // listEntriesRest. Narrowed rather than cast wholesale so that omission
    // stays visible in the types.
    const mine: SmokeEntry[] = entries
      .filter(
        (e) =>
          JSON.stringify(e.data ?? {}).includes(RUN_ID) ||
          JSON.stringify(e.metadata?.labels ?? {}).includes(RUN_ID),
      )
      // An entry whose only payload field is `message` is stored by Cloud Logging as
      // textPayload, so `data` arrives as a bare string — the backend's logWarn with no
      // context does. Normalised here so every lookup can read `data.message`.
      .map((e) => ({
        data: (typeof e.data === 'string' ? { message: e.data } : e.data) as SmokeEntryData,
        metadata: e.metadata as SmokeEntryMeta,
      }))
    process.stdout.write(`\r  … ${mine.length}/${want} entries after ${Math.round((Date.now() - started) / 1000)}s   `)
    if (mine.length >= want && ready(mine)) {
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

/**
 * Error Reporting's verdict, as it appears on the log entry itself.
 *
 * Cloud Logging stamps `errorGroups` onto an entry once Error Reporting has
 * associated it with a group. That is both faster and more direct than polling
 * `groupStats`, which is the console's own view and lags — the first version of
 * this leg asked the API and got nothing while the entries already carried their
 * group ids.
 */
/**
 * Where a symbolicated stack lives on an entry.
 *
 * BREAKING in 0.7.0: a reportable error carries its stack at top-level
 * `stack_trace` so Error Reporting can see it (#31), and loses the `stack` key
 * under `error` — one copy, not two. Anything below ERROR keeps it where it was.
 */
function stackOf(data: SmokeEntryData | undefined): string {
  return String(data?.stack_trace ?? data?.error?.stack ?? '')
}

function errorGroupIds(entry: SmokeEntry | undefined): string[] {
  const groups = entry?.metadata?.errorGroups ?? entry?.errorGroups
  if (!Array.isArray(groups)) return []
  return groups.map((g) => String(g?.id ?? '')).filter(Boolean)
}

/**
 * Wait for this run's three marked entries, and for Error Reporting to have
 * stamped its verdict on the two errors.
 *
 * Filtered on the marker rather than sweeping by run id: the generic sweep
 * counts every entry the run has produced so far, so its target is a moving
 * number that is easy to get wrong.
 */
async function waitForErrorGroups(marker: string, timeoutMs = 300_000): Promise<SmokeEntry[]> {
  const started = Date.now()
  let last: SmokeEntry[] = []
  let delay = 4_000
  while (Date.now() - started < timeoutMs) {
    const entries = await listEntriesRest(`jsonPayload.message:"${marker}"`)
    const grouped = entries.filter((e) => errorGroupIds(e).length > 0).length
    process.stdout.write(
      `\r  … ${entries.length}/3 entries, ${grouped}/2 grouped after ${Math.round((Date.now() - started) / 1000)}s   `,
    )
    if (entries.length >= 3 && grouped >= 2) {
      process.stdout.write('\n')
      return entries
    }
    last = entries
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 1.4, 15_000)
  }
  process.stdout.write('\n  timed out — asserting on what arrived\n')
  return last
}

/**
 * List entries through the REST API rather than the client library.
 *
 * `@google-cloud/logging` does not surface `errorGroups` — the field is absent
 * from the metadata it returns, though `logging.googleapis.com/v2/entries:list`
 * includes it. Reading it through the client is not slow or flaky, it is
 * impossible, which cost a full smoke run to discover.
 *
 * Shaped to match the client's `{ data, metadata }` so the assertions below do
 * not care which path an entry arrived by.
 */
async function listEntriesRest(filter: string): Promise<SmokeEntry[]> {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/logging.read'] })
  const client = await auth.getClient()
  const res = await client.request<{ entries?: Array<SmokeEntryMeta & { jsonPayload?: SmokeEntryData }> }>({
    url: 'https://logging.googleapis.com/v2/entries:list',
    method: 'POST',
    data: {
      resourceNames: [`projects/${PROJECT}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: 20,
    },
  })
  return (res.data.entries ?? []).map((e) => ({ data: e.jsonPayload, metadata: e, errorGroups: e.errorGroups }))
}

// --- the run --------------------------------------------------------------

/**
 * fsl doctor against the smoke project — a real Firebase layout, with the package
 * installed by `smoke:deploy`. The fake projects in tests/doctor.ts cover each finding;
 * this checks doctor reads a real firebase.json and node_modules the way it describes.
 * Here, not in npm test: it needs the maintainer's smoke install.
 */
function doctorLeg(): void {
  console.log('  --- fsl doctor on the smoke project ---')
  const report = runDoctor({ projectRoot: HERE })
  assert('it recognises the Firebase layout', report.setup.kind === 'firebase', `got: ${report.setup.kind}`)
  assert('the callable is available', report.setup.callable)
  assert('logging goes through firebase-functions', report.setup.logging === 'firebase-functions', `got: ${report.setup.logging}`)
  const errors = report.findings.filter((f) => f.level === 'error')
  assert('no errors', errors.length === 0, JSON.stringify(errors))
  for (const warning of report.findings.filter((f) => f.level === 'warning')) {
    console.log(`  (warning ${warning.id}: ${warning.message})`)
  }
}

async function main(): Promise<void> {
  console.log(`\nSmoke run ${RUN_ID}`)
  console.log(`  project ${PROJECT}  ·  release ${RELEASE_ID}\n`)

  doctorLeg()

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

  // 4. Wait for ingestion. 1 client entry + 3 backend entries — by name, not count.
  const messageOf = (e: SmokeEntry) => String(e.data?.message ?? '')
  const entries = await waitForEntries(4, undefined, (mine) =>
    mine.some((e) => messageOf(e).includes('client error')) &&
    mine.filter((e) => messageOf(e).includes('[fsl-verify] backend ')).length >= 3)
  if (entries.length === 0) {
    console.error('\n  No entries arrived within the timeout. Nothing further can be asserted.')
    failed++
    return
  }

  const payloads = entries.map((e) => ({ data: e.data, meta: e.metadata }))
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
  // RELEASE_ID is unique per run and has no embedded map, so resolving it at
  // all proves the lookup fell through to Storage rather than reusing whatever
  // the function was deployed with.
  const stack: string = stackOf(client?.data)
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

  console.log('\n  --- release-aware resolution (#20) ---')
  // A stack naming the EMBEDDED bundle but tagged with this run's release. The
  // embedded map exists under that filename, so before #20 it would have been
  // used regardless — the wrong map, confidently. Now the marker says the
  // embedded maps are for a different release, so Storage is tried first.
  await callFunction('fslSmokeClient', {
    message: `[fsl-verify] mismatched release ${RUN_ID}`,
    severity: 'ERROR',
    labels: { appId: env.FSL_SMOKE_APP_ID ?? 'smoke-app', releaseId: RELEASE_ID, errorType: 'fsl-verify', smokeRunId: RUN_ID },
    jsonPayload: {
      error: {
        message: `[fsl-verify] mismatched release ${RUN_ID}`,
        name: 'Error',
        stack: `duplicate@https://app.example.com/assets/${EMBEDDED_BUNDLE}:1:4`,
      },
    },
  })
  const mismatchEntries = await waitForEntries(5)
  const mismatch = mismatchEntries
    .map((e) => e.data)
    .find((d) => String(d?.message ?? '').includes('mismatched release'))
  const mstack: string = stackOf(mismatch)
  assert('the mismatched-release entry arrived', !!mismatch)
  // A length check would pass even if nothing resolved, so assert the actual
  // outcome: no Storage map exists for this run's release under the embedded
  // bundle name, so the documented behaviour is to fall back to the embedded
  // map. Seeing its source proves the marker shipped, the mismatch was
  // detected, Storage was consulted, and the fallback fired.
  assert(
    'it fell back to the embedded map rather than going dark',
    mstack.includes('embedded-at-deploy.ts'),
    `got: ${mstack}`,
  )
  assert('the bundle URL is gone', !mstack.includes(EMBEDDED_BUNDLE), `got: ${mstack}`)

  console.log('\n  --- feedback behind a WARNING floor (#9) ---')
  // fslSmokeFeedback runs a WARNING floor, so on severity alone both of these
  // are below it. Only the feedback marker should get one through. Sending the
  // plain NOTICE too is what makes this a test rather than a demonstration: if
  // the exemption ever keys on the severity instead of the marker, both arrive
  // and NOTICE has quietly become a level that defeats filtering.
  const FEEDBACK_TEXT = `[fsl-verify] the discount did not apply ${RUN_ID}`
  await callFunction('fslSmokeFeedback', {
    message: FEEDBACK_TEXT,
    severity: 'NOTICE',
    labels: { appId: env.FSL_SMOKE_APP_ID ?? 'smoke-app', feedback: 'true', errorType: 'fsl-verify', smokeRunId: RUN_ID, screen: 'Checkout', userId: 'smoke-user' },
    jsonPayload: {
      breadcrumbs: [
        { timestamp: Date.now(), type: 'nav', name: 'navigate_Checkout' },
        { timestamp: Date.now(), type: 'action', name: 'apply_discount' },
      ],
    },
  })
  await callFunction('fslSmokeFeedback', {
    message: `[fsl-verify] plain notice ${RUN_ID}`,
    severity: 'NOTICE',
    labels: { appId: env.FSL_SMOKE_APP_ID ?? 'smoke-app', errorType: 'fsl-verify', smokeRunId: RUN_ID },
  })
  console.log('  invoked fslSmokeFeedback twice (feedback + plain)')

  const afterFeedback = await waitForEntries(6)
  const seen = afterFeedback.map((e) => ({ data: e.data, meta: e.metadata }))
  const feedback = seen.find((p) => String(p.data?.message ?? '').includes('the discount did not apply'))
  const plainNotice = seen.find((p) => String(p.data?.message ?? '').includes('plain notice'))

  assert('the feedback entry survived the server floor', !!feedback,
    'it was dropped — the exemption is missing on the server side')
  assert('a plain NOTICE was still filtered out', !plainNotice,
    'the exemption is keying on the severity, not on the feedback marker')
  assert('Cloud Logging kept the NOTICE severity', feedback?.meta?.severity === 'NOTICE',
    `got: ${feedback?.meta?.severity}`)
  const fLabels = feedback?.meta?.labels ?? {}
  assert('feedback is an ENTRY label, so the console can filter on it', fLabels.feedback === 'true',
    `got: ${JSON.stringify(fLabels)}`)
  assert('the user is identified', fLabels.userId === 'smoke-user', `got: ${fLabels.userId}`)
  assert('the screen they were on rode along', fLabels.screen === 'Checkout', `got: ${fLabels.screen}`)
  assert('the breadcrumb trail rode along — this is what makes it reproducible',
    feedback?.data?.breadcrumbs?.length === 2, `got: ${JSON.stringify(feedback?.data?.breadcrumbs)}`)
  assert('filtering by labels.feedback finds it', (await queryByLabel('feedback', 'true')) > 0)

  console.log('\n  --- Cloud Error Reporting (#31) ---')
  // The whole question. Error Reporting groups by exception type plus the five
  // top-most frames — the fingerprint we would otherwise build. It reads
  // `stack_trace` at the top level of jsonPayload; ours lived under `error`, so
  // it was never seen. Everything below is downstream of whether that one
  // change is enough.
  //
  // What could sink it: our client errors are WRITTEN BY a Cloud Function, and
  // Error Reporting attributes groups to a service. If serviceContext.service is
  // ignored and every browser error is filed under the log collector, the
  // grouping is one useless bucket.
  const SERVICE = env.FSL_SMOKE_APP_ID ?? 'smoke-app'
  const ERR_MARKER = `fsl-er-${RUN_ID}`

  // Two errors from the SAME source location with DIFFERENT messages. If
  // grouping keys on the resolved frames they are one group; if it keys on the
  // message they are two; if it keys on the MINIFIED frames the whole idea is
  // dead, because those differ every release.
  for (const suffix of ['alpha', 'beta']) {
    await callFunction('fslSmokeClient', {
      message: `${ERR_MARKER} ${suffix}`,
      severity: 'ERROR',
      labels: { appId: SERVICE, releaseId: RELEASE_ID, errorType: 'fsl-verify', smokeRunId: RUN_ID },
      jsonPayload: {
        error: {
          message: `${ERR_MARKER} ${suffix}`,
          name: 'TypeError',
          stack: `duplicate@https://app.example.com/assets/${BUNDLE}:1:4`,
        },
      },
    })
  }

  // A WARNING carrying a stack, and a feedback report. Neither should become
  // something a person has to resolve.
  await callFunction('fslSmokeClient', {
    message: `${ERR_MARKER} warning`,
    severity: 'WARNING',
    labels: { appId: SERVICE, releaseId: RELEASE_ID, errorType: 'fsl-verify', smokeRunId: RUN_ID },
    jsonPayload: {
      error: { message: `${ERR_MARKER} warning`, name: 'Error', stack: `duplicate@https://app.example.com/assets/${BUNDLE}:1:4` },
    },
  })
  console.log('  invoked fslSmokeClient x3 (two errors, one warning)')

  // Two waits, not one. The entry is ingested first and Error Reporting stamps
  // `errorGroups` onto it afterwards — so an assertion made the moment the entry
  // appears reads an empty list and concludes, wrongly, that nothing grouped.
  const erEntries = await waitForErrorGroups(ERR_MARKER)
  const byMarker = (needle: string) =>
    erEntries.find((e) => JSON.stringify(e.data ?? {}).includes(needle))

  const alpha = byMarker(`${ERR_MARKER} alpha`)
  const beta = byMarker(`${ERR_MARKER} beta`)
  const warned = byMarker(`${ERR_MARKER} warning`)

  assert('the two errors arrived', !!alpha && !!beta)
  assert('the warning arrived', !!warned)

  const alphaGroups = errorGroupIds(alpha)
  const betaGroups = errorGroupIds(beta)

  assert('an error group was created at all — the whole question', alphaGroups.length > 0,
    'Error Reporting saw nothing; stack_trace at the top level is not sufficient')

  // The one that decides whether this is worth anything. Two errors from the
  // same source line with DIFFERENT messages: one group means the grouping keys
  // on the resolved frames, which only we can supply. Two groups would mean it
  // keys on the message, and the whole idea is a message-dedupe with extra steps.
  assert('both errors from one source line share a group', 
    alphaGroups.length > 0 && alphaGroups[0] === betaGroups[0],
    `alpha=${JSON.stringify(alphaGroups)} beta=${JSON.stringify(betaGroups)} — grouping is not keying on the resolved frames`)

  // What was most likely to sink this: client errors are WRITTEN BY a Cloud
  // Function, and Error Reporting attributes groups to a service. If
  // serviceContext.service were ignored, every browser error in every app would
  // land in one bucket named after the log collector.
  const ctx = alpha?.data?.serviceContext
  assert('the group is attributed to our appId, not the log-collector function',
    ctx?.service === SERVICE, `serviceContext: ${JSON.stringify(ctx)}`)
  assert('and carries the release, so a regression is attributable',
    ctx?.version === RELEASE_ID, `got: ${ctx?.version}`)

  assert('the symbolicated stack is what was reported', 
    String(alpha?.data?.stack_trace ?? '').includes('catalogProducts.ts'),
    `stack_trace: ${String(alpha?.data?.stack_trace ?? '').slice(0, 120)}`)
  assert('and it is not duplicated under error',
    Boolean(alpha?.data?.error) && !('stack' in (alpha?.data?.error ?? {})),
    `error: ${JSON.stringify(alpha?.data?.error)}`)

  // Regression guards. An error group is something a person has to resolve.
  assert('the WARNING did not become an error group', errorGroupIds(warned).length === 0,
    'a warning became something a person has to resolve')
  const feedbackEntry = erEntries.find((e) => String(e.data?.message ?? '').includes('the discount did not apply'))
  assert('feedback did not become an error group',
    !feedbackEntry || errorGroupIds(feedbackEntry).length === 0,
    'a user report became a bug someone has to resolve')

  console.log(`  group ${alphaGroups[0]} — both errors, one group`)

  console.log('\n  --- backend path ---')
  const bLabels = backendInfo?.meta?.labels ?? {}
  assert('functionName is set by withLogging', bLabels.functionName === 'fslSmokeBackend', `got: ${bLabels.functionName}`)
  assert('the run id rode through AsyncLocalStorage', bLabels.smokeRunId === RUN_ID, `got: ${bLabels.smokeRunId}`)

  // The trace id is why /functions still uses firebase-functions' write() where it is
  // installed (#39): only it can see the trace of the current invocation. Lose it and
  // "show entries for this trace" in Logs Explorer stops grouping one call's logs —
  // silently, since every entry still arrives.
  console.log('\n  --- trace ---')
  const traceOf = (p: { meta?: SmokeEntryMeta } | undefined) => p?.meta?.trace ?? ''
  const backendTraces = payloads
    .filter((p) => String(p.data?.message ?? '').includes('[fsl-verify] backend '))
    .map(traceOf)
  const ours = `projects/${PROJECT}/traces/`
  assert('the client entry carries a trace', traceOf(client).startsWith(ours), `got: ${traceOf(client)}`)
  assert('all three backend entries arrived', backendTraces.length === 3, `got: ${backendTraces.length}`)
  assert('every backend entry carries a trace', backendTraces.every((t) => t.startsWith(ours)),
    `got: ${backendTraces.join(', ')}`)
  assert('one invocation shares one trace', new Set(backendTraces).size === 1, `got: ${backendTraces.join(', ')}`)
  assert('two invocations do not', traceOf(client) !== backendTraces[0])

  await cloudRunLeg()
  await bigEntryLeg()
  await repeatSummaryLeg()
  await realClientLeg()
  await thrownErrorLeg()
}

// --- Cloud Run: the backend without firebase-functions or firebase-admin (#39) ---

const CLOUD_RUN_SERVICE = 'fsl-cloudrun-smoke'

/**
 * The URL of the Cloud Run smoke service, or null if it is not deployed.
 * gcloud rather than a client library: the identity token below comes from the
 * same CLI login, and nothing else in the harness needs the Run Admin API.
 */
function cloudRunUrl(): string | null {
  try {
    const url = execSync(
      `gcloud run services describe ${CLOUD_RUN_SERVICE} --project ${PROJECT} --region ${REGION} --format="value(status.url)"`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return url || null
  } catch {
    return null
  }
}

async function cloudRunLeg(): Promise<void> {
  console.log('\n  --- Cloud Run: no firebase-functions, no firebase-admin ---')
  const url = cloudRunUrl()
  assert('the Cloud Run smoke service is deployed', url !== null, 'run `npm run smoke:deploy:run` first')
  if (!url) return

  // The service is private; Cloud Run's IAM check is the gate. The token comes from
  // the gcloud login, not ADC.
  const token = execSync('gcloud auth print-identity-token', { encoding: 'utf-8' }).trim()
  const traceId = RUN_ID.toLowerCase().padEnd(32, '0').replace(/[^0-9a-f]/g, '0')
  const marker = `[fsl-verify] cloud run ${RUN_ID}`
  const res = await fetch(`${url}/log`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Cloud-Trace-Context': `${traceId}/1;o=1`,
    },
    body: JSON.stringify({
      message: marker,
      severity: 'ERROR',
      labels: {
        appId: env.FSL_SMOKE_APP_ID ?? 'smoke-app',
        releaseId: RELEASE_ID,
        errorType: 'fsl-cloud-run',
        smokeRunId: RUN_ID,
      },
      jsonPayload: {
        // The same bundle and release as the client leg, so this resolves from the
        // map uploaded at the top of the run — through @google-cloud/storage this
        // time, step 2 of the Storage chain.
        error: { message: marker, name: 'Error', stack: `duplicate@https://app.example.com/assets/${BUNDLE}:1:4` },
      },
      attachments: { note: Buffer.from(`cloud run ${RUN_ID}`).toString('base64') },
    }),
  })
  assert('the service answers 204', res.status === 204, `got ${res.status}: ${(await res.text()).slice(0, 200)}`)
  if (res.status !== 204) return

  // Polled on the marker until Error Reporting has stamped a group, which also
  // waits out ingestion.
  let entry: SmokeEntry | undefined
  const started = Date.now()
  let delay = 4_000
  while (Date.now() - started < 300_000) {
    entry = (await listEntriesRest(`jsonPayload.message:"${marker}"`))[0]
    process.stdout.write(`\r  … ${entry ? 'arrived' : 'waiting'}, ${errorGroupIds(entry).length ? 'grouped' : 'not grouped'} after ${Math.round((Date.now() - started) / 1000)}s   `)
    if (entry && errorGroupIds(entry).length > 0) break
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 1.4, 15_000)
  }
  process.stdout.write('\n')

  const meta = entry?.metadata
  const labels = meta?.labels ?? {}
  const resource = meta?.resource as { type?: string } | undefined
  assert('the entry arrived', entry !== undefined)
  assert('it came from Cloud Run, not a function', resource?.type === 'cloud_run_revision', `got: ${resource?.type}`)
  assert('ERROR went to stderr', String(meta?.logName ?? '').endsWith('run.googleapis.com%2Fstderr'), `got: ${meta?.logName}`)
  assert('labels are entry labels', labels.smokeRunId === RUN_ID && labels.errorType === 'fsl-cloud-run',
    `got: ${JSON.stringify(labels)}`)
  // Cloud Run sets no project variable, so this also proves the metadata-server
  // lookup in resolveTraceProject ran (#39).
  assert('the trace is the header id, as a full resource name',
    meta?.trace === `projects/${PROJECT}/traces/${traceId}`, `got: ${meta?.trace}`)

  // The claim that matters: "show entries for this trace" in Logs Explorer filters on
  // the full resource name, and Cloud Run's own request log is written in that form.
  // A bare id never meets it — an earlier run of this check is how that was found.
  const traced = await listEntriesRest(`trace="projects/${PROJECT}/traces/${traceId}"`)
  assert("the console's trace filter finds our entry",
    traced.some((e) => String(e.data?.message ?? '') === marker), `found ${traced.length} entries`)
  assert("and Cloud Run's request log for the same call",
    traced.some((e) => String(e.metadata?.logName ?? '').endsWith('run.googleapis.com%2Frequests')),
    `logs: ${traced.map((e) => String(e.metadata?.logName ?? '').split('/').pop()).join(', ')}`)
  assert('the stack resolved from Storage without firebase-admin',
    stackOf(entry?.data).includes('catalogProducts.ts'), `got: ${stackOf(entry?.data).slice(0, 160)}`)
  assert('serviceContext names the app and release',
    entry?.data?.serviceContext?.version === RELEASE_ID, `got: ${JSON.stringify(entry?.data?.serviceContext)}`)
  assert('Error Reporting grouped it', errorGroupIds(entry).length > 0)
  assert('hasAttachments is flagged', labels.hasAttachments === 'true', `got: ${labels.hasAttachments}`)
  if (labels.logId) {
    const [exists] = await storage.bucket(BUCKET).file(`logAttachments/${labels.logId}/note`).exists()
    assert('the attachment was written without firebase-admin', exists,
      `looked for logAttachments/${labels.logId}/note`)
  }
}

// --- A 300 KB entry: shortened, still JSON, the full copy in Storage (#21) ---

/**
 * Cloud Functions and Cloud Run cut a log line at 102,400 bytes, and past that the
 * entry arrives as broken text with no severity or labels. writeLog shortens anything
 * over 90 KiB and saves the whole entry as fsl-overflow.json. This sends 300 KB through
 * the callable and asserts what arrives — the only place the platform's cut is real.
 */
async function bigEntryLeg(): Promise<void> {
  console.log('\n  --- a 300 KB entry: shortened, not broken ---')
  const marker = `[fsl-verify] big entry ${RUN_ID}`
  await callFunction('fslSmokeClient', {
    message: marker,
    severity: 'ERROR',
    labels: { appId: env.FSL_SMOKE_APP_ID ?? 'smoke-app', releaseId: RELEASE_ID, errorType: 'fsl-big', smokeRunId: RUN_ID },
    jsonPayload: {
      error: { message: marker, name: 'Error', stack: `duplicate@https://app.example.com/assets/${BUNDLE}:1:4` },
      context: { blob: 'x'.repeat(300 * 1024) },
    },
  })

  let entry: SmokeEntry | undefined
  const started = Date.now()
  let delay = 4_000
  while (Date.now() - started < 240_000 && !entry) {
    entry = (await listEntriesRest(`jsonPayload.message:"${marker}"`))[0]
    if (!entry) {
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 1.4, 15_000)
    }
  }

  const labels = entry?.metadata?.labels ?? {}
  assert('it arrived as JSON, not broken text', entry !== undefined)
  assert('severity survived', entry?.metadata?.severity === 'ERROR', `got: ${entry?.metadata?.severity}`)
  assert('labels survived', labels.errorType === 'fsl-big' && labels.smokeRunId === RUN_ID, `got: ${JSON.stringify(labels)}`)
  assert('it is marked truncated', labels.truncated === 'true', `got: ${labels.truncated}`)
  assert('the context was dropped', entry?.data?.context === undefined)
  assert('the stack still resolved', stackOf(entry?.data).includes('catalogProducts.ts'), `got: ${stackOf(entry?.data).slice(0, 120)}`)
  assert('hasAttachments points at the full copy', labels.hasAttachments === 'true', `got: ${labels.hasAttachments}`)
  if (labels.logId) {
    const file = storage.bucket(BUCKET).file(`logAttachments/${labels.logId}/fsl-overflow.json`)
    const [exists] = await file.exists()
    assert('fsl-overflow.json exists at the logId path', exists, `looked for logAttachments/${labels.logId}/fsl-overflow.json`)
    if (exists) {
      const [content] = await file.download()
      const full = JSON.parse(content.toString()) as { context?: { blob?: string } }
      assert('and holds the whole 300 KB context', full.context?.blob?.length === 300 * 1024,
        `got ${full.context?.blob?.length}`)
    }
  }
}

// --- A repeat summary keeps its own time (#40) ---

/**
 * A repeat summary is sent after the fact — up to an hour later, or on a later visit —
 * so writeLog writes the client's `timestamp` into the entry, but only for a summary
 * (`labels.repeatCount` present) and only within the last 8 days. The unit suites prove
 * the entry carries the field; only Cloud Logging can say it honours it. This sends a
 * summary stamped two hours ago and a plain WARNING carrying the same stamp, and checks
 * that the first lands two hours back and the second at the time it was written.
 */
async function repeatSummaryLeg(): Promise<void> {
  console.log('\n  --- a repeat summary keeps its own time ---')
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const stamp = twoHoursAgo.toISOString()
  const summaryMarker = `[fsl-verify] repeat summary ${RUN_ID}`
  const plainMarker = `[fsl-verify] plain with timestamp ${RUN_ID}`
  const base = { appId: env.FSL_SMOKE_APP_ID ?? 'smoke-app', releaseId: RELEASE_ID, smokeRunId: RUN_ID }

  const sentAt = Date.now()
  await callFunction('fslSmokeClient', {
    message: summaryMarker,
    severity: 'WARNING',
    // The same body the client gives a summary (sendRepeatSummary), so it is
    // filed as JSON and not textPayload.
    jsonPayload: { context: { repeat: { count: 197 } } },
    labels: {
      ...base,
      repeatOf: 'smoke-repeat-key',
      repeatCount: '197',
      firstSeen: new Date(twoHoursAgo.getTime() - 50 * 60 * 1000).toISOString(),
      lastSeen: stamp,
      sentLate: 'true',
    },
    timestamp: stamp,
  })
  await callFunction('fslSmokeClient', {
    message: plainMarker,
    severity: 'WARNING',
    labels: base,
    // Without a second payload field, Cloud Logging files a message-only entry as
    // textPayload, and the jsonPayload.message filter below would never see it.
    jsonPayload: { context: { runId: RUN_ID } },
    timestamp: stamp,
  })

  // Filtered on the marker, with a window reaching back past the stamp — a
  // summary filed two hours ago is outside any "since the run started" window.
  const find = async (marker: string) =>
    (await listEntriesRest(`jsonPayload.message:"${marker}" AND timestamp >= "${new Date(twoHoursAgo.getTime() - 60_000).toISOString()}"`))[0]
  let summary: SmokeEntry | undefined
  let plain: SmokeEntry | undefined
  const started = Date.now()
  let delay = 4_000
  while (Date.now() - started < 240_000 && (!summary || !plain)) {
    summary ??= await find(summaryMarker)
    plain ??= await find(plainMarker)
    if (!summary || !plain) {
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 1.4, 15_000)
    }
  }

  const summaryTime = Date.parse(summary?.metadata?.timestamp ?? '')
  const plainTime = Date.parse(plain?.metadata?.timestamp ?? '')
  assert('the summary arrived', summary !== undefined)
  assert('it is filed at its own lastSeen, two hours back',
    Math.abs(summaryTime - twoHoursAgo.getTime()) < 1_000, `got: ${summary?.metadata?.timestamp}, sent: ${stamp}`)
  const labels = summary?.metadata?.labels ?? {}
  assert('its repeat labels survived', labels.repeatCount === '197' && labels.repeatOf === 'smoke-repeat-key'
    && labels.sentLate === 'true', `got: ${JSON.stringify(labels)}`)
  assert('the plain WARNING arrived', plain !== undefined)
  assert('a non-summary keeps the server\'s time, not the one it sent',
    Math.abs(plainTime - sentAt) < 5 * 60 * 1000, `got: ${plain?.metadata?.timestamp}, sent stamp: ${stamp}`)
}

// --- The real client logger, end to end (#77) ---

const PATH_A_ACTIONS = ['apply_discount', 'tap_place_order']
const PATH_B_ACTIONS = ['edit_quantity', 'tap_place_order']
const REAL_CLIENT_FULL_COPIES = 6
const REAL_CLIENT_SUMMARIES = 2

interface ChildRun {
  exitCode: number
  output: string
}

/**
 * Runs `smoke/realClient.ts` in its own process, so jsdom's `window` never exists where
 * the Google client libraries run. The callable's URL holds the project id, so it goes in
 * through the environment and is scrubbed from anything the child printed.
 */
async function runRealClientScript(callableUrl: string, errorMessage: string): Promise<ChildRun> {
  const childEnv = {
    ...process.env,
    FSL_SMOKE_CALLABLE_URL: callableUrl,
    FSL_SMOKE_APP_ID: env.FSL_SMOKE_APP_ID ?? 'smoke-app',
    FSL_SMOKE_RELEASE_ID: RELEASE_ID,
    FSL_SMOKE_RUN_ID: RUN_ID,
    FSL_SMOKE_ERROR_MESSAGE: errorMessage,
  }
  const scrub = (text: string) => text.split(callableUrl).join('<callable url>')
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', path.join(HERE, 'realClient.ts')],
      { env: childEnv, encoding: 'utf-8' },
    )
    return { exitCode: 0, output: scrub(stdout + stderr) }
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string }
    return { exitCode: typeof failed.code === 'number' ? failed.code : 1, output: scrub(`${failed.stdout ?? ''}${failed.stderr ?? ''}`) }
  }
}

function actionsSinceLastNav(entry: SmokeEntry): string[] {
  const crumbs = entry.data?.breadcrumbs ?? []
  const lastNavIndex = crumbs.map((crumb) => crumb.type).lastIndexOf('nav')
  return crumbs
    .slice(lastNavIndex + 1)
    .filter((crumb) => crumb.type === 'action')
    .map((crumb) => crumb.name)
}

/**
 * The real working-tree `/client` logger, run in jsdom by `smoke/realClient.ts`, sends
 * through the deployed `fslSmokeClient`. One user reaches one error on one screen by two
 * paths, four times each, then the tab goes hidden. What the client decided (which copy is
 * a repeat, what a summary carries, which breadcrumbs go with an entry) is asserted where
 * it ends up. Runs last: its entries carry the run id, so the earlier legs' counts would
 * otherwise include them.
 */
async function realClientLeg(): Promise<void> {
  console.log('\n  --- the real client, end to end ---')
  const errorMessage = `[fsl-verify] real client checkout failed ${RUN_ID}`
  const child = await runRealClientScript(functionUrl('fslSmokeClient'), errorMessage)
  for (const line of child.output.split('\n').filter(Boolean)) console.log(`  child: ${line}`)
  assert('the real client process sent every entry and exited 0', child.exitCode === 0, `exit code ${child.exitCode}`)

  const wanted = REAL_CLIENT_FULL_COPIES + REAL_CLIENT_SUMMARIES
  const filter = `labels.smokeRunId="${RUN_ID}" AND jsonPayload.message:"${errorMessage}"`
  let entries: SmokeEntry[] = []
  const started = Date.now()
  let delay = 4_000
  while (Date.now() - started < 240_000 && entries.length < wanted) {
    entries = await listEntriesRest(filter)
    if (entries.length < wanted) {
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 1.4, 15_000)
    }
  }

  const keyOf = (entry: SmokeEntry) => entry.metadata?.labels?.repeatKey
  const fullCopies = entries.filter((e) => keyOf(e) !== undefined)
  const summaries = entries.filter((e) => e.metadata?.labels?.repeatOf !== undefined)
  const sameActions = (a: string[], b: string[]) => a.join() === b.join()
  const copiesOnPath = (actions: string[]) => fullCopies.filter((e) => sameActions(actionsSinceLastNav(e), actions))
  const distinctKeys = (copies: SmokeEntry[]) => [...new Set(copies.map(keyOf))]

  assert(`${REAL_CLIENT_FULL_COPIES} full copies arrived`, fullCopies.length === REAL_CLIENT_FULL_COPIES, `got ${fullCopies.length}`)
  assert('they carry 2 distinct repeatKeys', distinctKeys(fullCopies).length === 2, `got ${distinctKeys(fullCopies).length}`)
  for (const [name, actions] of [['A', PATH_A_ACTIONS], ['B', PATH_B_ACTIONS]] as const) {
    const copies = copiesOnPath(actions)
    const keys = distinctKeys(copies)
    assert(`path ${name}: 3 full copies, one repeatKey, breadcrumbs show ${actions.join(' then ')}`,
      copies.length === 3 && keys.length === 1,
      `got ${copies.length} copies under ${keys.length} keys; actions seen: ${JSON.stringify(fullCopies.map(actionsSinceLastNav))}`)
    const summariesOfPath = summaries.filter((e) => e.metadata?.labels?.repeatOf === keys[0])
    assert(`path ${name}: one summary points at its repeatKey`, keys.length === 1 && summariesOfPath.length === 1,
      `got ${summariesOfPath.length}`)
    assert(`path ${name}: the summary counts 1 repeat`, summariesOfPath[0]?.metadata?.labels?.repeatCount === '1',
      `got ${summariesOfPath[0]?.metadata?.labels?.repeatCount}`)
  }
  assert(`${REAL_CLIENT_SUMMARIES} summaries arrived`, summaries.length === REAL_CLIENT_SUMMARIES, `got ${summaries.length}`)
}

// --- What withLogging does with a throw, next to Firebase's own wrapper (#84) ---

const THROWN_PLAIN_ENTRIES = 2
const THROWN_REFUSAL_ENTRIES = 1
const THROWN_LOGGED_ENTRIES = 2
const THROWN_SETTLE_MS = 10_000

type ThrowMode = 'plain' | 'refusal' | 'logged'

function textOf(entry: SmokeEntry | undefined): string {
  const textPayload = entry?.metadata?.textPayload
  return typeof textPayload === 'string' ? textPayload : String(entry?.data?.message ?? '')
}

const isFslThrowsEntry = (entry: SmokeEntry) => entry.metadata?.labels?.functionName === 'fslSmokeThrows'

async function entriesHoldingMessage(message: string, since: Date, want: number): Promise<SmokeEntry[]> {
  const filter = `"${message}" AND timestamp >= "${since.toISOString()}"`
  let entries: SmokeEntry[] = []
  const started = Date.now()
  let delay = 4_000
  while (Date.now() - started < 240_000 && entries.length < want) {
    entries = await listEntriesRest(filter)
    if (entries.length < want) {
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 1.4, 15_000)
    }
  }
  await new Promise((r) => setTimeout(r, THROWN_SETTLE_MS))
  return listEntriesRest(filter)
}

/**
 * Calls `fslSmokeThrows` three ways and asserts what the caller gets and which entries hold
 * each message. Found by text, not by label: Firebase's own `Unhandled error` entry has no
 * fsl label, and a label filter would hide the entry this leg is there to count.
 */
async function thrownErrorLeg(): Promise<void> {
  console.log('\n  --- what a handler throws ---')
  const since = new Date(Date.now() - 60_000)
  const messages: Record<ThrowMode, string> = {
    plain: `[fsl-verify] thrown plain ${RUN_ID}`,
    refusal: `[fsl-verify] thrown refusal ${RUN_ID}`,
    logged: `[fsl-verify] thrown logged ${RUN_ID}`,
  }
  const answers = {} as Record<ThrowMode, CallerAnswer>
  for (const mode of ['plain', 'refusal', 'logged'] as const) {
    answers[mode] = await callFunctionForAnswer('fslSmokeThrows', { runId: RUN_ID, mode, message: messages[mode] })
  }
  const describeAnswer = (a: CallerAnswer) => `HTTP ${a.httpStatus}, status ${a.errorStatus}`
  const severities = (entries: SmokeEntry[]) => entries.map((e) => e.metadata?.severity).join(',')

  assert('plain: the caller gets 500 INTERNAL', answers.plain.httpStatus === 500 && answers.plain.errorStatus === 'INTERNAL',
    describeAnswer(answers.plain))
  assert('refusal: the caller gets 403 PERMISSION_DENIED with the message sent',
    answers.refusal.httpStatus === 403 && answers.refusal.errorStatus === 'PERMISSION_DENIED' &&
      answers.refusal.errorMessage === messages.refusal,
    `${describeAnswer(answers.refusal)}, message matches: ${answers.refusal.errorMessage === messages.refusal}`)
  assert('logged: the caller gets 500 INTERNAL', answers.logged.httpStatus === 500 && answers.logged.errorStatus === 'INTERNAL',
    describeAnswer(answers.logged))

  const plain = await entriesHoldingMessage(messages.plain, since, THROWN_PLAIN_ENTRIES)
  const plainFsl = plain.filter(isFslThrowsEntry)
  const plainFirebase = plain.filter((e) => !isFslThrowsEntry(e))
  assert(`plain: ${THROWN_PLAIN_ENTRIES} entries hold the message`, plain.length === THROWN_PLAIN_ENTRIES,
    `got ${plain.length}, severities ${severities(plain)}`)
  assert("plain: one is fsl's ERROR with the run id and the error payload",
    plainFsl.length === 1 && plainFsl[0].metadata?.severity === 'ERROR' &&
      plainFsl[0].metadata?.labels?.smokeRunId === RUN_ID && plainFsl[0].data?.error?.message === messages.plain,
    `fsl entries ${plainFsl.length}, severity ${plainFsl[0]?.metadata?.severity}, error message matches: ${plainFsl[0]?.data?.error?.message === messages.plain}`)
  assert("plain: one is Firebase's Unhandled error, with no functionName label",
    plainFirebase.length === 1 && textOf(plainFirebase[0]).includes('Unhandled error'),
    `other entries ${plainFirebase.length}, text starts: ${textOf(plainFirebase[0]).slice(0, 40)}`)

  const refusal = await entriesHoldingMessage(messages.refusal, since, THROWN_REFUSAL_ENTRIES)
  const refusalFsl = refusal.filter(isFslThrowsEntry)
  assert(`refusal: ${THROWN_REFUSAL_ENTRIES} entry holds the message and none of it is Firebase's`,
    refusal.length === THROWN_REFUSAL_ENTRIES && refusalFsl.length === refusal.length,
    `got ${refusal.length}, fsl's ${refusalFsl.length}, severities ${severities(refusal)}`)
  assert("refusal: fsl's entry is a WARNING with the code and status, and no error payload",
    refusalFsl[0]?.metadata?.severity === 'WARNING' &&
      refusalFsl[0].metadata?.labels?.smokeRunId === RUN_ID &&
      refusalFsl[0].data?.context?.code === 'permission-denied' &&
      refusalFsl[0].data?.context?.status === 403 &&
      refusalFsl[0].data?.error === undefined,
    `severity ${refusalFsl[0]?.metadata?.severity}, code ${String(refusalFsl[0]?.data?.context?.code)}, status ${String(refusalFsl[0]?.data?.context?.status)}, has error payload: ${refusalFsl[0]?.data?.error !== undefined}`)

  const logged = await entriesHoldingMessage(messages.logged, since, THROWN_LOGGED_ENTRIES)
  const loggedFsl = logged.filter(isFslThrowsEntry)
  assert(`logged: ${THROWN_LOGGED_ENTRIES} entries hold the message, not 3`, logged.length === THROWN_LOGGED_ENTRIES,
    `got ${logged.length}, severities ${severities(logged)}`)
  assert("logged: one is fsl's ERROR from logError, one is Firebase's",
    loggedFsl.length === 1 && loggedFsl[0].metadata?.severity === 'ERROR' && logged.length - loggedFsl.length === 1,
    `fsl entries ${loggedFsl.length}, other entries ${logged.length - loggedFsl.length}, severity ${loggedFsl[0]?.metadata?.severity}`)
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
