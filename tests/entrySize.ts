/**
 * The 100 KiB entry-size budget (issue #21 item 2).
 *
 * Cloud Functions and Cloud Run both cut a stdout/stderr log line at exactly
 * 102,400 bytes. Past that the platform delivers broken plain text with no
 * severity or labels — verified live. writeLog's production branch measures
 * the finished entry and shrinks it under MAX_ENTRY_BYTES before writing, so
 * this has to run with FUNCTIONS_EMULATOR unset, same as productionOutput and
 * storageChain.
 *
 * Run: npx tsx tests/entrySize.ts
 */

if (process.env.FUNCTIONS_EMULATOR === 'true') {
  console.error('Run with FUNCTIONS_EMULATOR unset — this suite tests the production branch')
  process.exit(1)
}

import Module from 'module'
import { initializeApp } from 'firebase-admin/app'
import { writeLog, initLogger } from '../src/functions/logger.js'
import {
  configureAttachments,
  resetAttachmentConfig,
  resetStorageResolution,
} from '../src/functions/sourceMapCache.js'
import { attachmentPath } from '../src/shared/paths.js'
import { assert, reportResults } from './testHelpers.js'

// Any real upload fails fast on a closed local port, never reaching real Storage.
process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9'
initializeApp({ projectId: 'demo-entry-size' })
initLogger({ appId: 'entry-size', minSeverity: 'DEBUG' })

// --- staging "firebase-admin is not installed" (see storageChain.ts) ---

type Load = (request: string, parent: unknown, isMain: boolean) => unknown
const loader = Module as unknown as { _load: Load }
const realLoad = loader._load

function blockFirebaseAdmin(): () => void {
  loader._load = function (request, parent, isMain) {
    if (request.startsWith('firebase-admin')) {
      throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' })
    }
    return realLoad.call(this, request, parent, isMain)
  }
  return () => {
    loader._load = realLoad
  }
}

function withoutFirebaseAdmin<T>(fn: () => T): T {
  const restore = blockFirebaseAdmin()
  try {
    return fn()
  } finally {
    restore()
  }
}

/** Run `fn` with stdout AND stderr captured, returning every JSON line emitted. */
function captureEntries(fn: () => void): Record<string, unknown>[] {
  const lines: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const grab = ((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stdout.write = grab
  process.stderr.write = grab
  try {
    fn()
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
  return lines
    .join('')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = realWarn
  }
}

/** Let queued promises (an overflow upload's .catch) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 1))
}

const bigString = (bytes: number) => 'x'.repeat(bytes)

function labelsOf(entry: Record<string, unknown> | undefined): Record<string, string> {
  return (entry?.['logging.googleapis.com/labels'] as Record<string, string>) ?? {}
}

// --- Runs first: the once-per-process warning, before any other oversized entry ---

function testWarnsOnceAcrossTwoOversizedEntries() {
  console.log('\nTest: the over-budget warning fires once, not per entry')
  const bigContext = { blob: bigString(300 * 1024) }

  const { warnings } = captureWarnings(() => {
    captureEntries(() =>
      writeLog({
        message: 'first oversized',
        severity: 'ERROR',
        labels: { appId: 'entry-size' } as never,
        jsonPayload: { context: bigContext },
      }),
    )
    captureEntries(() =>
      writeLog({
        message: 'second oversized',
        severity: 'ERROR',
        labels: { appId: 'entry-size' } as never,
        jsonPayload: { context: bigContext },
      }),
    )
  })

  const overBudgetWarnings = warnings.filter((w) => w.includes('was over') && w.includes('bytes'))
  assert('the warning fires exactly once', overBudgetWarnings.length === 1, warnings.join('\n'))
}

// --- Small entries pass through untouched ---

function testSmallEntryUntouched() {
  console.log('\nTest: a small entry is written untouched')
  const [entry] = captureEntries(() =>
    writeLog({
      message: 'all good',
      severity: 'INFO',
      labels: { appId: 'entry-size', userId: 'u_1' } as never,
      jsonPayload: { context: { orderId: 'o_1' } },
    }),
  )

  const labels = labelsOf(entry)
  assert('no truncated label', labels.truncated === undefined, `got: ${labels.truncated}`)
  assert('the message is unchanged', entry?.message === 'all good')
  assert('the context is unchanged', JSON.stringify(entry?.context) === JSON.stringify({ orderId: 'o_1' }))
  assert('userId survived', labels.userId === 'u_1')
}

// --- A 300 KB context, with an attachment bucket configured ---

async function testLargeContextIsShrunkWithAttachment() {
  console.log('\nTest: a 300 KB context is shrunk, and hasAttachments is claimed')
  configureAttachments({ bucket: 'demo-entry-size' })

  const stack = 'Error: boom\n    at Checkout.tsx:1:1'
  const [entry] = captureEntries(() =>
    writeLog({
      message: 'checkout failed',
      severity: 'ERROR',
      labels: { appId: 'entry-size', userId: 'u_2' } as never,
      jsonPayload: {
        context: { blob: bigString(300 * 1024) },
        error: { message: 'boom', name: 'Error', stack },
      },
    }),
  )

  const line = JSON.stringify(entry)
  assert('the written line is under 90 KiB', Buffer.byteLength(line, 'utf-8') <= 90 * 1024, `${Buffer.byteLength(line, 'utf-8')} bytes`)
  assert('it still parses as JSON', (() => {
    try {
      JSON.parse(line)
      return true
    } catch {
      return false
    }
  })())
  assert('severity is ERROR', entry?.severity === 'ERROR')

  const labels = labelsOf(entry)
  assert('userId survived', labels.userId === 'u_2')
  assert('truncated is set', labels.truncated === 'true', `got: ${labels.truncated}`)
  assert('hasAttachments is set', labels.hasAttachments === 'true', `got: ${labels.hasAttachments}`)
  assert('context is gone', !('context' in (entry ?? {})))
  assert('stack_trace survived', typeof entry?.stack_trace === 'string' && entry.stack_trace.includes('Checkout.tsx'))
  assert('serviceContext survived', !!entry?.serviceContext)

  // Let this call's own overflow upload fail and warn now, quietly, rather
  // than mid-flight during a later test's own capture window.
  await flush()
  resetAttachmentConfig()
}

// --- 50 breadcrumbs, each carrying ~5 KB of data ---

function testBreadcrumbsShrinkToLastTenWithoutData() {
  console.log('\nTest: 50 breadcrumbs shrink to the last 10, without data')
  const breadcrumbs = Array.from({ length: 50 }, (_, i) => ({
    timestamp: i,
    type: 'action' as const,
    name: `step_${i}`,
    data: { blob: bigString(5 * 1024) },
  }))

  const [entry] = captureEntries(() =>
    writeLog({
      message: 'a long session',
      severity: 'ERROR',
      labels: { appId: 'entry-size' } as never,
      jsonPayload: { breadcrumbs },
    }),
  )

  const kept = entry?.breadcrumbs as Array<Record<string, unknown>> | undefined
  assert('exactly 10 breadcrumbs remain', kept?.length === 10, `got: ${kept?.length}`)
  assert('the last 10 are kept, in order', kept?.[9]?.name === 'step_49' && kept?.[0]?.name === 'step_40')
  assert('none carry data', kept?.every((b) => !('data' in b)) ?? false)
  assert('truncated is set', labelsOf(entry).truncated === 'true')
}

// --- A 5,000-line stack, nothing else big ---

function testHugeStackKeepsTopFrames() {
  console.log('\nTest: a 5,000-line stack is cut, keeping the top frames')
  const frames = Array.from({ length: 5000 }, (_, i) => `    at frame${i} (file.js:${i}:1)`)
  const stack = ['Error: boom', ...frames].join('\n')

  const [entry] = captureEntries(() =>
    writeLog({
      message: 'deep stack',
      severity: 'ERROR',
      labels: { appId: 'entry-size' } as never,
      jsonPayload: { error: { message: 'boom', name: 'Error', stack } },
    }),
  )

  const stackTrace = entry?.stack_trace as string | undefined
  assert('stack_trace is present', typeof stackTrace === 'string')
  assert('the header/top frame survived', !!stackTrace?.includes('frame0'))
  assert('the bottom frames were cut', !stackTrace?.includes('frame4999'))
  assert('the truncation marker is present', !!stackTrace?.includes('… truncated by fsl'))

  const line = JSON.stringify(entry)
  assert('the written line is under 90 KiB', Buffer.byteLength(line, 'utf-8') <= 90 * 1024)
}

// --- A 200 KB message ---

function testHugeMessageIsCutWithEllipsis() {
  console.log('\nTest: a 200 KB message is cut to 8 KiB, ending in an ellipsis')
  const [entry] = captureEntries(() =>
    writeLog({
      message: bigString(200 * 1024),
      severity: 'ERROR',
      labels: { appId: 'entry-size' } as never,
    }),
  )

  const message = entry?.message as string | undefined
  assert('the message was cut', !!message && message.length < 200 * 1024)
  assert('it is at most 8 KiB', !!message && Buffer.byteLength(message, 'utf-8') <= 8 * 1024)
  assert('it ends with an ellipsis', message?.endsWith('…') ?? false)
}

// --- Nothing but oversized labels ---

function testLabelValuesAreCutOnlyWhenNothingElseCanBe() {
  console.log('\nTest: label values over 1 KiB are cut when nothing else is left to shrink')
  const labels: Record<string, string> = { appId: 'entry-size', userId: 'u_5' }
  for (let i = 0; i < 40; i++) labels[`big${i}`] = bigString(5 * 1024)
  const [entry] = captureEntries(() =>
    writeLog({ message: 'labels only', severity: 'ERROR', labels: labels as never }),
  )

  const written = labelsOf(entry)
  assert('every label is at most 1 KiB', Object.values(written).every((v) => Buffer.byteLength(v, 'utf-8') <= 1024))
  assert('a long label ends with an ellipsis', written.big0?.endsWith('…') ?? false)
  assert('a short label is untouched', written.userId === 'u_5')
  assert('truncated is set', written.truncated === 'true')
  assert('the message is untouched', entry?.message === 'labels only')
}

// --- No Storage at all ---

function testNoStorageStillShortensWithoutHasAttachments() {
  console.log('\nTest: with no Storage, the entry is still shortened, unflagged for attachments')
  resetAttachmentConfig()
  withoutFirebaseAdmin(() => {
    resetStorageResolution()
    const [entry] = captureEntries(() =>
      writeLog({
        message: 'no storage here',
        severity: 'ERROR',
        labels: { appId: 'entry-size' } as never,
        jsonPayload: { context: { blob: bigString(300 * 1024) } },
      }),
    )

    const labels = labelsOf(entry)
    assert('truncated is set', labels.truncated === 'true', `got: ${labels.truncated}`)
    assert('hasAttachments is not set', labels.hasAttachments === undefined, `got: ${labels.hasAttachments}`)
    const line = JSON.stringify(entry)
    assert('the written line is under 90 KiB', Buffer.byteLength(line, 'utf-8') <= 90 * 1024)
  })
  resetStorageResolution()
}

// --- The overflow upload's own target and failure ---

async function testOverflowUploadTargetsTheAttachmentPath() {
  console.log("\nTest: the overflow upload targets logAttachments/<logId>/fsl-overflow.json, and a failure warns")
  configureAttachments({ bucket: 'demo-entry-size' })

  // The upload happens after the entry is written, so its failure warning
  // arrives asynchronously — the console.warn stub has to stay in place
  // across the flush, not just the synchronous writeLog call.
  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  let entries: Record<string, unknown>[]
  try {
    entries = captureEntries(() =>
      writeLog({
        message: 'overflow target',
        severity: 'ERROR',
        labels: { appId: 'entry-size' } as never,
        jsonPayload: { context: { blob: bigString(300 * 1024) } },
      }),
    )
    await flush()
  } finally {
    console.warn = realWarn
  }

  const entry = entries[0]
  const logId = labelsOf(entry).logId
  assert('a logId was assigned', typeof logId === 'string' && logId.length > 0, `got: ${logId}`)

  const expectedPath = attachmentPath(logId!, 'fsl-overflow.json')
  const encodedPath = encodeURIComponent(expectedPath)
  assert(
    'the failed upload names the overflow object',
    warnings.some((w) => w.includes(expectedPath) || w.includes(encodedPath)),
    warnings.join('\n'),
  )

  resetAttachmentConfig()
}

// --- Circular context ---

function testSelfReferencingContextDoesNotThrow() {
  console.log('\nTest: a large, self-referencing context does not throw')
  const context: Record<string, unknown> = { blob: bigString(300 * 1024) }
  context.self = context

  let threw = false
  let entry: Record<string, unknown> | undefined
  try {
    ;[entry] = captureEntries(() =>
      writeLog({
        message: 'circular',
        severity: 'ERROR',
        labels: { appId: 'entry-size' } as never,
        jsonPayload: { context },
      }),
    )
  } catch {
    threw = true
  }

  assert('it does not throw', !threw)
  assert('an entry was still written', !!entry)
}

// --- Runner ---

async function run() {
  testWarnsOnceAcrossTwoOversizedEntries()
  testSmallEntryUntouched()
  await testLargeContextIsShrunkWithAttachment()
  testBreadcrumbsShrinkToLastTenWithoutData()
  testHugeStackKeepsTopFrames()
  testHugeMessageIsCutWithEllipsis()
  testLabelValuesAreCutOnlyWhenNothingElseCanBe()
  testNoStorageStillShortensWithoutHasAttachments()
  await testOverflowUploadTargetsTheAttachmentPath()
  testSelfReferencingContextDoesNotThrow()
  reportResults()
}

run()
