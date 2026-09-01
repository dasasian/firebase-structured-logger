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
import { getLogger } from '../src/functions/requestLogger.js'
import { assert, reportResults } from './testHelpers.js'
import { runWithTrace, traceIdFromHeaders } from '../src/functions/traceContext.js'

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


// --- Unknown severity (#28) ---

function testUnknownSeverityDoesNotCrash() {
  console.log('\nTest: an unrecognised severity is written as ERROR, not lost')

  // writeLog is exported, so a caller can reach it with a value read from
  // config, crossing a type boundary, or from plain JavaScript. ffWrite looks
  // the severity up in a fixed table; a miss resolves to undefined and calling
  // it throws — swallowed by Logger.send()'s catch, so the entry vanishes with
  // no diagnostic, in production only.
  let threw = false
  let entries: Record<string, unknown>[] = []
  try {
    entries = captureEntries(() =>
      writeLog({
        message: 'from a bad severity',
        severity: 'DEFAULT' as never,
        labels: { appId: 'acme' } as never,
      }),
    )
  } catch {
    threw = true
  }

  assert('nothing was thrown', !threw, 'ffWrite crashed on the unknown value')
  assert('the entry survived', entries.length === 1, `got ${entries.length} entries`)
  assert('it was written as ERROR', entries[0]?.severity === 'ERROR', `got: ${entries[0]?.severity}`)
  assert('the message is intact', entries[0]?.message === 'from a bad severity')
}

function testUnknownSeverityIsNotSilent() {
  console.log('\nTest: the coercion warns, naming the bad value')

  const warned: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')) }
  try {
    captureEntries(() =>
      writeLog({ message: 'x', severity: 'NOPE' as never, labels: { appId: 'acme' } as never }),
    )
  } finally {
    console.warn = realWarn
  }

  assert('it warned', warned.length > 0)
  assert('the bad value is named', warned.some((w) => w.includes('NOPE')), `warnings: ${JSON.stringify(warned)}`)
  assert('the valid values are listed', warned.some((w) => w.includes('ERROR') && w.includes('DEBUG')))
}

function testUnknownSeverityBypassedTheFloor() {
  console.log('\nTest: an unknown severity no longer slips past the min-severity floor')
  initLogger({ appId: 'acme', minSeverity: 'ERROR' })

  // SEVERITY_ORDER[unknown] is undefined and `undefined > n` is false, so the
  // floor check used to pass for any unrecognised value. Coerced to ERROR it is
  // now ranked, and an ERROR floor admits it.
  const kept = captureEntries(() =>
    writeLog({ message: 'coerced', severity: 'WHATEVER' as never, labels: { appId: 'acme' } as never }),
  )
  assert('it is ranked, not unranked', kept.length === 1, `got ${kept.length}`)
  assert('as ERROR', kept[0]?.severity === 'ERROR')

  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })
}


// --- NOTICE on the production branch (#9) ---

function testNoticeIsEmittedVerbatim() {
  console.log('\nTest: NOTICE reaches Cloud Logging as NOTICE')
  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })

  // firebase-functions maps NOTICE to console.info, so it lands on stdout — but
  // the severity FIELD must still say NOTICE, because that is what Cloud Logging
  // reads. If the mapping leaked into the field, feedback would arrive as INFO
  // and the severity dropdown would not separate it.
  const [entry] = captureEntries(() =>
    writeLog({ message: 'user feedback', severity: 'NOTICE', labels: { appId: 'acme' } as never }),
  )

  assert('an entry was written', !!entry)
  assert('severity is NOTICE, not INFO', entry?.severity === 'NOTICE', `got: ${entry?.severity}`)
}

function testNoticeRanksBetweenWarningAndInfo() {
  console.log('\nTest: NOTICE ranks between WARNING and INFO')

  // A NOTICE floor admits NOTICE and above, and excludes routine INFO. That
  // ordering is the reason NOTICE was chosen: feedback from a person outranks
  // status chatter without being a warning about system health.
  initLogger({ appId: 'acme', minSeverity: 'NOTICE' })

  const notice = captureEntries(() =>
    writeLog({ message: 'n', severity: 'NOTICE', labels: { appId: 'acme' } as never }),
  )
  const info = captureEntries(() =>
    writeLog({ message: 'i', severity: 'INFO', labels: { appId: 'acme' } as never }),
  )
  const warning = captureEntries(() =>
    writeLog({ message: 'w', severity: 'WARNING', labels: { appId: 'acme' } as never }),
  )

  assert('NOTICE is admitted at a NOTICE floor', notice.length === 1)
  assert('WARNING is admitted', warning.length === 1)
  assert('INFO is excluded', info.length === 0, 'NOTICE is not ranked above INFO')

  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })
}

function testPlainNoticeStillRespectsTheFloor() {
  console.log('\nTest: an ordinary NOTICE still respects the floor')

  // The exemption must key on the record being feedback, not on the severity.
  // Otherwise NOTICE becomes a level that silently defeats filtering for
  // everyone, and any `severity >= WARNING` sink starts behaving unpredictably.
  initLogger({ appId: 'acme', minSeverity: 'WARNING' })
  const dropped = captureEntries(() =>
    writeLog({ message: 'not feedback', severity: 'NOTICE', labels: { appId: 'acme' } as never }),
  )
  assert('a bare NOTICE is dropped at a WARNING floor', dropped.length === 0, `got ${dropped.length}`)

  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })
}

function testFeedbackSurvivesTheServerFloor() {
  console.log('\nTest: feedback survives the SERVER floor, not just the client one')

  // The client exempts itself from its own floor, but the payload still passes
  // through writeLog on its way to Cloud Logging — and this floor defaults to
  // WARNING in production. Implementing only the client half meant every report
  // was dropped here instead, silently, in production only. It was, until this
  // test existed.
  initLogger({ appId: 'acme', minSeverity: 'WARNING' })

  const [entry] = captureEntries(() =>
    writeLog({
      message: 'the discount did not apply',
      severity: 'NOTICE',
      labels: { appId: 'acme', feedback: 'true' } as never,
    }),
  )

  assert('the report was written', !!entry, 'feedback was dropped at the server floor')
  assert('at NOTICE', entry?.severity === 'NOTICE', `got: ${entry?.severity}`)
  assert('the text survived', entry?.message === 'the discount did not apply')

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

/**
 * Cloud Logging groups a request's entries by trace. firebase-functions attaches
 * `logging.googleapis.com/trace` from its own AsyncLocalStorage, populated only
 * inside its request wrapper — empty on Cloud Run and anything behind
 * createHttpLogHandler (#34). Without this the entries arrive uncorrelated and
 * nothing says why, which is the worst shape a gap can take.
 */
function testTraceIsAttachedOutsideCloudFunctions() {
  console.log('\nTest: a trace id from request headers reaches the entry')
  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })
  const previous = process.env.GOOGLE_CLOUD_PROJECT
  process.env.GOOGLE_CLOUD_PROJECT = 'demo-project'

  try {
    const traceId = '105445aa7843bc8bf206b12000100000'
    const [entry] = captureEntries(() =>
      runWithTrace(traceId, () =>
        writeLog({ message: 'traced', severity: 'ERROR', labels: { appId: 'acme' } as never }),
      ),
    )
    assert(
      'the trace is a full resource name, not a bare id',
      entry?.['logging.googleapis.com/trace'] === `projects/demo-project/traces/${traceId}`,
      String(entry?.['logging.googleapis.com/trace']),
    )

    // Outside a request there is nothing to correlate, and an empty or partial
    // trace field is worse than none — Cloud Logging rejects a malformed one.
    const [untraced] = captureEntries(() =>
      writeLog({ message: 'untraced', severity: 'ERROR', labels: { appId: 'acme' } as never }),
    )
    assert('and is absent entirely when there is no trace', !('logging.googleapis.com/trace' in (untraced ?? {})))

    // No project means no valid resource name can be built.
    delete process.env.GOOGLE_CLOUD_PROJECT
    delete process.env.GCLOUD_PROJECT
    const [noProject] = captureEntries(() =>
      runWithTrace(traceId, () =>
        writeLog({ message: 'no project', severity: 'ERROR', labels: { appId: 'acme' } as never }),
      ),
    )
    assert(
      'omitted rather than written wrong when the project is unknown',
      !('logging.googleapis.com/trace' in (noProject ?? {})),
      String(noProject?.['logging.googleapis.com/trace']),
    )
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_CLOUD_PROJECT
    else process.env.GOOGLE_CLOUD_PROJECT = previous
  }
}

/**
 * Two formats reach a Google backend: Cloud Trace's own header from Google's
 * load balancers, and W3C traceparent from OpenTelemetry and most third-party
 * tracers. A malformed one is dropped rather than guessed at — an invalid trace
 * resource name costs the whole entry, not just its correlation.
 */
function testTraceHeaderParsing() {
  console.log('\nTest: both trace header formats, and neither when malformed')
  const id = '105445aa7843bc8bf206b12000100000'

  assert('Cloud Trace with span and sampling flag', traceIdFromHeaders({ 'x-cloud-trace-context': `${id}/1;o=1` }) === id)
  assert('Cloud Trace with just the id', traceIdFromHeaders({ 'x-cloud-trace-context': id }) === id)
  assert(
    'W3C traceparent',
    traceIdFromHeaders({ traceparent: `00-${id}-00f067aa0ba902b7-01` }) === id,
  )
  assert(
    'Cloud Trace wins when both are present',
    traceIdFromHeaders({ 'x-cloud-trace-context': `${id}/1`, traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-00f067aa0ba902b7-01' }) === id,
  )

  // Nothing guarantees the host framework lower-cased them.
  assert('header names are case-insensitive', traceIdFromHeaders({ 'X-Cloud-Trace-Context': id }) === id)
  assert('an array-valued header takes the first', traceIdFromHeaders({ 'x-cloud-trace-context': [id, 'other'] }) === id)

  assert('a short id is not accepted', traceIdFromHeaders({ 'x-cloud-trace-context': 'abc123/1' }) === undefined)
  assert('a non-hex id is not accepted', traceIdFromHeaders({ 'x-cloud-trace-context': 'z'.repeat(32) }) === undefined)
  assert('a truncated traceparent is not accepted', traceIdFromHeaders({ traceparent: `00-${id}` }) === undefined)
  assert('no headers at all', traceIdFromHeaders({}) === undefined)
}

/**
 * Cloud Error Reporting reads Cloud Logging and groups by exception type plus
 * the five top-most frames — the fingerprint we would otherwise build ourselves
 * (#31). It looks for `stack_trace` at the top level of jsonPayload; ours lived
 * one level down under `error`, so it was never seen.
 *
 * This is only worth anything because we symbolicate first. For an ordinary web
 * app the top frames are `app-4f2a.js:1:98432` — different every release, so
 * nothing groups and the product is useless on web.
 */
function testErrorReportingShape() {
  console.log('\nTest: an ERROR carries the shape Error Reporting reads')
  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })

  const stack = 'TypeError: x is undefined\n    at Checkout.tsx:42:9'
  const [entry] = captureEntries(() =>
    writeLog({
      message: 'x is undefined',
      severity: 'ERROR',
      labels: { appId: 'acme', releaseId: 'abc1234' } as never,
      jsonPayload: { error: { message: 'x is undefined', name: 'TypeError', stack } },
    }),
  )

  assert('stack_trace is at the top level, where it is read', entry?.stack_trace === stack, String(entry?.stack_trace))
  const ctx = entry?.serviceContext as Record<string, string> | undefined
  assert('serviceContext names the app', ctx?.service === 'acme', JSON.stringify(ctx))
  assert('and the release', ctx?.version === 'abc1234', JSON.stringify(ctx))

  // Moved, not duplicated — the stack is the largest field in an entry capped at
  // 256 KB, and two copies buy nothing. BREAKING in 0.7.0: anything reading
  // jsonPayload.error.stack for a production error reads stack_trace now.
  const err = entry?.error as Record<string, string> | undefined
  assert('the stack is gone from the error payload', !('stack' in (err ?? {})), JSON.stringify(err))
  assert('but the rest of the error survives', err?.name === 'TypeError' && err?.message === 'x is undefined', JSON.stringify(err))
}

/**
 * The regression guard. An Error Reporting group is something a person has to
 * resolve, so anything that becomes one by accident is a chore we invented for
 * our users.
 */
function testWhatMustNotBecomeAnErrorGroup() {
  console.log('\nTest: warnings, feedback and stackless errors stay out of Error Reporting')
  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })
  const stack = 'Error: slow\n    at Checkout.tsx:7:1'

  const [warning] = captureEntries(() =>
    writeLog({
      message: 'slow request',
      severity: 'WARNING',
      labels: { appId: 'acme' } as never,
      jsonPayload: { error: { message: 'slow', name: 'Error', stack } },
    }),
  )
  assert('a WARNING with a stack is not reportable', !('stack_trace' in (warning ?? {})), String(warning?.stack_trace))
  // It has to go somewhere, and this is where it already was.
  assert('and keeps its stack under error', (warning?.error as Record<string, string>)?.stack === stack)

  // Feedback is a person telling you something, not a crash. It arrives at
  // NOTICE and is exempt from the floors; it must not arrive as a bug report.
  const [feedback] = captureEntries(() =>
    writeLog({
      message: 'the discount did not apply',
      severity: 'ERROR',
      labels: { appId: 'acme', feedback: 'true' } as never,
      jsonPayload: { error: { message: 'x', name: 'Error', stack } },
    }),
  )
  assert('feedback is never an error group, even at ERROR', !('stack_trace' in (feedback ?? {})), String(feedback?.stack_trace))
  assert('and keeps its stack under error', (feedback?.error as Record<string, string>)?.stack === stack)

  // Nothing to group on. Error Reporting would fall back to the message, which
  // for us means one group per distinct string — noise, not issues.
  const [stackless] = captureEntries(() =>
    writeLog({ message: 'plain error', severity: 'ERROR', labels: { appId: 'acme' } as never }),
  )
  assert('an error with no stack is not reportable', !('stack_trace' in (stackless ?? {})))
  assert('and carries no serviceContext either', !('serviceContext' in (stackless ?? {})))
}

/**
 * The server half of #31, which resolves `serviceContext.service` differently
 * from the client half and had never been exercised.
 *
 * A client error carries `appId` in the labels the browser sent. A backend one
 * usually does not — `withLogging` only sets `appId` if a caller passes one — so
 * it falls back to the `appId` given to `initLogger`. Same shape, different
 * source, and nothing checked the fallback.
 */
function testBackendErrorsReportToo() {
  console.log('\nTest: a backend error is reportable, with appId from initLogger')
  initLogger({ appId: 'acme-backend', minSeverity: 'DEBUG' })

  const err = new Error('order lookup failed')
  err.stack = 'Error: order lookup failed\n    at checkout.ts:88:3'

  // getLogger() outside a request returns the anonymous writer — the same
  // closure withLogging binds, minus the request labels.
  const [entry] = captureEntries(() => getLogger().error(err, { orderId: 'o-1' }))

  assert('the stack is at stack_trace', entry?.stack_trace === err.stack, String(entry?.stack_trace))
  const ctx = entry?.serviceContext as Record<string, string> | undefined
  assert('service falls back to the initLogger appId', ctx?.service === 'acme-backend', JSON.stringify(ctx))
  // No releaseId on the backend — there is no build to tie it to. Absent rather
  // than empty, since an empty version would split groups on nothing.
  assert('and omits version when there is no releaseId', !ctx || !('version' in ctx), JSON.stringify(ctx))

  assert('errorType is still labelled', (entry?.['logging.googleapis.com/labels'] as any)?.errorType === 'Error')
  assert('and the stack is not duplicated under error', !('stack' in ((entry?.error as object) ?? {})), JSON.stringify(entry?.error))

  initLogger({ appId: 'acme', minSeverity: 'DEBUG' })
}

function run() {
  testJsonPayloadIsSpreadNotNested()
  testLabelsArePromotedToEntryLabels()
  testSeverityIsTheLiteralCloudLoggingString()
  testMessageIsTopLevel()
  testNoServerInjectedStack()
  testAttachmentsAreStrippedButFlagged()
  testHasAttachmentsAbsentWhenNoneGiven()
  testMinSeverityFloorAppliesInProductionToo()
  testUnknownSeverityDoesNotCrash()
  testUnknownSeverityIsNotSilent()
  testUnknownSeverityBypassedTheFloor()
  testNoticeIsEmittedVerbatim()
  testNoticeRanksBetweenWarningAndInfo()
  testPlainNoticeStillRespectsTheFloor()
  testFeedbackSurvivesTheServerFloor()
  testWholeEntryShape()
  testErrorReportingShape()
  testWhatMustNotBecomeAnErrorGroup()
  testBackendErrorsReportToo()
  testTraceIsAttachedOutsideCloudFunctions()
  testTraceHeaderParsing()
  reportResults()
}

run()
