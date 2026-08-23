/**
 * Production writeLog output shape.
 *
 * writeLog has two branches that emit STRUCTURALLY DIFFERENT entries, and every
 * other functions suite runs with FUNCTIONS_EMULATOR=true — so only the branch
 * that never runs in production was tested:
 *
 *   emulator    { severity, message, labels, jsonPayload: { ... } }   nested
 *   production  { severity, message, labels, ...jsonPayload }        SPREAD
 *
 * Nesting that spread back would have passed all other assertions and surfaced
 * weeks later from a production log.
 *
 * ffWrite writes structured JSON to stdout; Cloud Logging ingests by parsing
 * exactly those bytes. So capturing stdout gives the precise payload Google
 * receives, instantly and with no credentials.
 *
 * Run with FUNCTIONS_EMULATOR **unset**:
 *   npx tsx tests/productionOutput.ts
 */

if (process.env.FUNCTIONS_EMULATOR === 'true') {
  console.error('Run with FUNCTIONS_EMULATOR unset — this suite tests the production branch')
  process.exit(1)
}

import { writeLog, initLogger } from '../src/functions/logger.js'
import { assert, reportResults } from './testHelpers.js'

initLogger({ appId: 'acme', minSeverity: 'DEBUG' })

/**
 * Run `fn` with stdout AND stderr captured, returning every JSON line emitted.
 *
 * firebase-functions routes by severity through a snapshot of console taken at
 * module load: ERROR and CRITICAL go to console.error (stderr), everything else
 * to console.info/debug/warn. Capturing only stdout silently misses every error
 * entry — which is most of what matters here.
 */
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

// --- The shape ---

function testJsonPayloadIsSpreadNotNested() {
  console.log('\nTest: jsonPayload is SPREAD to top level, not nested')

  const [entry] = captureEntries(() =>
    writeLog({
      message: 'checkout failed',
      severity: 'ERROR',
      labels: { appId: 'acme', screen: 'Checkout' } as never,
      jsonPayload: {
        context: { orderId: 'o_1' },
        breadcrumbs: [{ timestamp: 1, type: 'action', name: 'tap_pay' }],
        error: { message: 'boom', name: 'Error', stack: 'Error: boom\n  at x' },
      },
    }),
  )

  assert('an entry was written to stdout', !!entry)

  // The regression this file exists for.
  assert('there is NO jsonPayload key', !('jsonPayload' in entry), `keys: ${Object.keys(entry).join(', ')}`)
  assert('context is top level', 'context' in entry, `keys: ${Object.keys(entry).join(', ')}`)
  assert('breadcrumbs are top level', 'breadcrumbs' in entry)
  assert('error is top level', 'error' in entry)
}

function testLabelsArePromotedToEntryLabels() {
  console.log('\nTest: labels are emitted under the key Cloud Logging promotes')

  const [entry] = captureEntries(() =>
    writeLog({
      message: 'hello',
      severity: 'INFO',
      labels: { appId: 'acme', screen: 'Home', userId: 'u_1' } as never,
    }),
  )

  // The key name is load-bearing. ffWrite does no mapping, and Cloud Logging only
  // promotes specifically-named fields to LogEntry.labels. A plain `labels` key
  // lands in jsonPayload instead, and `labels.appId="..."` filters match nothing —
  // confirmed live before this was fixed.
  const labels = entry['logging.googleapis.com/labels'] as Record<string, string> | undefined
  assert('labels use the logging.googleapis.com/labels key', !!labels, `keys: ${Object.keys(entry).join(', ')}`)
  assert('a plain "labels" key is NOT emitted', !('labels' in entry), `keys: ${Object.keys(entry).join(', ')}`)
  assert('appId survived', labels?.appId === 'acme')
  assert('screen survived', labels?.screen === 'Home')
  assert('userId survived', labels?.userId === 'u_1')
  assert('a logId was added', typeof labels?.logId === 'string' && labels.logId.length === 26)
}

function testSeverityIsTheLiteralCloudLoggingString() {
  console.log('\nTest: severity is emitted as the literal Cloud Logging string')

  for (const severity of ['ERROR', 'WARNING', 'INFO', 'DEBUG'] as const) {
    const [entry] = captureEntries(() =>
      writeLog({ message: 'm', severity, labels: { appId: 'acme' } as never }),
    )
    assert(`${severity} is emitted verbatim`, entry.severity === severity, `got: ${entry.severity}`)
  }
}

function testMessageIsTopLevel() {
  console.log('\nTest: message is a top-level field, not wrapped')
  const [entry] = captureEntries(() =>
    writeLog({ message: 'a plain message', severity: 'INFO', labels: { appId: 'acme' } as never }),
  )
  assert('message is top level', entry.message === 'a plain message', `got: ${JSON.stringify(entry.message)}`)
}

function testNoServerInjectedStack() {
  console.log('\nTest: no stack is injected onto a non-error entry')
  const [entry] = captureEntries(() =>
    writeLog({ message: 'just info', severity: 'INFO', labels: { appId: 'acme' } as never }),
  )
  // Bypassing entryFromArgs is what avoids this; a nested stack would mean the
  // wrapper crept back in.
  assert('no stack key', !('stack' in entry), `keys: ${Object.keys(entry).join(', ')}`)
  assert('no error key when none was supplied', !('error' in entry))
}

function testAttachmentsAreStrippedButFlagged() {
  console.log('\nTest: attachments are flagged in labels, never inlined into the entry')
  const [entry] = captureEntries(() =>
    writeLog({
      message: 'with attachment',
      severity: 'INFO',
      labels: { appId: 'acme' } as never,
      attachments: { note: Buffer.from('hi').toString('base64') },
    }),
  )

  const labels = entry['logging.googleapis.com/labels'] as Record<string, string>
  assert('hasAttachments label is set', labels.hasAttachments === 'true', `got: ${labels.hasAttachments}`)
  assert('the base64 payload is NOT in the log entry', !('attachments' in entry), `keys: ${Object.keys(entry).join(', ')}`)
}

function testHasAttachmentsAbsentWhenNoneGiven() {
  console.log('\nTest: hasAttachments is absent when there are none')
  const [entry] = captureEntries(() =>
    writeLog({ message: 'plain', severity: 'INFO', labels: { appId: 'acme' } as never }),
  )
  assert('no hasAttachments label', !('hasAttachments' in (entry['logging.googleapis.com/labels'] as object)))
}

// --- The severity floor on this branch ---

function testMinSeverityFloorAppliesInProductionToo() {
  console.log('\nTest: the min-severity floor drops entries on the production branch too')
  initLogger({ appId: 'acme', minSeverity: 'WARNING' })

  const dropped = captureEntries(() =>
    writeLog({ message: 'chatty', severity: 'INFO', labels: { appId: 'acme' } as never }),
  )
  assert('INFO is dropped below a WARNING floor', dropped.length === 0, `got ${dropped.length} entries`)

  const kept = captureEntries(() =>
    writeLog({ message: 'real', severity: 'ERROR', labels: { appId: 'acme' } as never }),
  )
  assert('ERROR is kept', kept.length === 1)

  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })
}

// --- A full entry, pinned ---

function testWholeEntryShape() {
  console.log('\nTest: the complete entry shape, pinned')

  const [entry] = captureEntries(() =>
    writeLog({
      message: 'checkout failed',
      severity: 'ERROR',
      labels: { appId: 'acme', screen: 'Checkout' } as never,
      jsonPayload: { context: { orderId: 'o_1' }, error: { message: 'boom', name: 'Error' } },
    }),
  )

  const keys = Object.keys(entry).sort()
  const expected = ['context', 'error', 'logging.googleapis.com/labels', 'message', 'severity']
  assert(
    'exactly the expected top-level keys',
    JSON.stringify(keys) === JSON.stringify(expected),
    `got: ${keys.join(', ')} | expected: ${expected.join(', ')}`,
  )

  console.log('\n  Entry as Cloud Logging receives it:')
  console.log(JSON.stringify(entry, null, 2).split('\n').map((l) => '    ' + l).join('\n'))
}

// --- Runner ---

function run() {
  testJsonPayloadIsSpreadNotNested()
  testLabelsArePromotedToEntryLabels()
  testSeverityIsTheLiteralCloudLoggingString()
  testMessageIsTopLevel()
  testNoServerInjectedStack()
  testAttachmentsAreStrippedButFlagged()
  testHasAttachmentsAbsentWhenNoneGiven()
  testMinSeverityFloorAppliesInProductionToo()
  testWholeEntryShape()
  reportResults()
}

run()
