/**
 * `fsl logs` against a fake transport: the flags, the normaliser, the limit line, the
 * fix-it errors, `--repeats` and `attachments`. No gcloud, no project, no network.
 *
 * Run: npx tsx tests/logsQuery.ts
 */

import fs from 'fs'
import path from 'path'
import { assert, reportResults } from './testHelpers.js'
import { FAKE_BUCKET, FAKE_PROJECT, FIXED_NOW, cloudEntry, runFsl, tempProject, withFirebaserc } from './logsHelpers.js'
import { buildCloudFilter } from '../src/tools/logs/cloudFilter.js'
import { normalizeCloudEntry, normalizeLocalEntry } from '../src/tools/logs/entry.js'
import { GcloudError, readCloudEntriesWith } from '../src/tools/logs/gcloud.js'
import { runLogs } from '../src/tools/logs/command.js'

function parsedLines(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function testBothSourcesNormaliseToOneShape() {
  console.log('\nTest: a gcloud entry and an emulator line normalise to the same shape')
  const fromCloud = normalizeCloudEntry(
    cloudEntry({ severity: 'ERROR', message: 'cart sync failed', labels: { screen: 'Cart', logId: 'L1' }, payload: { error: { message: 'boom' } } }),
  )
  const fromLocal = normalizeLocalEntry({
    timestamp: fromCloud.timestamp,
    severity: 'ERROR',
    message: 'cart sync failed',
    labels: { appId: 'demo-app', screen: 'Cart', logId: 'L1' },
    jsonPayload: { error: { message: 'boom' } },
    functionName: 'handler',
  })
  assert('same timestamp, severity and message', fromCloud.timestamp === fromLocal.timestamp && fromCloud.severity === fromLocal.severity && fromCloud.message === fromLocal.message)
  assert('same labels', JSON.stringify(fromCloud.labels) === JSON.stringify(fromLocal.labels), JSON.stringify([fromCloud.labels, fromLocal.labels]))
  assert('same functionName', fromCloud.functionName === fromLocal.functionName)
  assert('payload loses the message that now sits on the entry', JSON.stringify(fromCloud.jsonPayload) === JSON.stringify(fromLocal.jsonPayload), JSON.stringify([fromCloud.jsonPayload, fromLocal.jsonPayload]))
  assert('cloud-only fields stay cloud-only', fromCloud.trace !== undefined && fromLocal.trace === undefined)
  const v2 = normalizeCloudEntry({ ...cloudEntry({}), labels: undefined, jsonPayload: { message: 'm', labels: { screen: 'Home' } } })
  assert('labels under jsonPayload (Cloud Run v2) are read too', v2.labels.screen === 'Home')
}

async function testGcloudOutputIsParsedAsOneArray() {
  console.log('\nTest: the transport asks gcloud for json and parses the array')
  const calls: string[][] = []
  const read = readCloudEntriesWith(async (args) => {
    calls.push(args)
    return JSON.stringify([cloudEntry({})])
  })
  const entries = await read({ projectId: FAKE_PROJECT, filter: 'severity="ERROR"', limit: 10 })
  assert('one entry back', entries.length === 1)
  assert('--format json and the project are passed', calls[0].includes('json') && calls[0].includes('--project') && calls[0].includes(FAKE_PROJECT))
  const empty = await readCloudEntriesWith(async () => '')({ projectId: FAKE_PROJECT, filter: '', limit: 1 })
  assert('empty output is no entries', empty.length === 0)
}

async function testWhereSelectAndOrder() {
  console.log('\nTest: --where, --select and the default time order')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const cloud = [
    cloudEntry({ minutesAgo: 1, severity: 'ERROR', message: 'late', labels: { userId: 'u1', screen: 'Cart' } }),
    cloudEntry({ minutesAgo: 30, severity: 'INFO', message: 'early', labels: { userId: 'u1', screen: 'Home' } }),
    cloudEntry({ minutesAgo: 10, severity: 'INFO', message: 'other user', labels: { userId: 'u2', screen: 'Home' } }),
  ]
  const run = await runFsl(['--where', 'labels.userId=u1', '--since', '2h', '--select', 'timestamp,severity,labels.screen,message'], { cwd, cloud })
  const lines = parsedLines(run.stdout)
  assert('exits 0', run.code === 0, run.stderr.join('\n'))
  assert('only u1 entries', lines.length === 2, JSON.stringify(lines))
  assert('oldest first', lines[0].message === 'early' && lines[1].message === 'late')
  assert('select keeps only the named fields', Object.keys(lines[0]).sort().join() === 'labels.screen,message,severity,timestamp', Object.keys(lines[0]).join())
  assert('a known label is sent to the server', run.cloudRequests[0].filter.includes('labels.userId="u1"'), run.cloudRequests[0].filter)
  assert('--since becomes a timestamp bound', run.cloudRequests[0].filter.includes('timestamp>="2026-03-10T10:00:00.000Z"'), run.cloudRequests[0].filter)
  assert('the project id is not printed', ![...run.stdout, ...run.stderr].join('\n').includes(FAKE_PROJECT))
}

async function testOperators() {
  console.log('\nTest: != >= <= and ~')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const cloud = [
    cloudEntry({ severity: 'ERROR', message: 'Payment Declined', labels: { screen: 'Pay' } }),
    cloudEntry({ severity: 'INFO', message: 'ok', labels: { screen: 'Home' } }),
  ]
  const notHome = await runFsl(['--where', 'labels.screen!=Home'], { cwd, cloud })
  assert('!= drops the match', parsedLines(notHome.stdout).length === 1)
  const contains = await runFsl(['--where', 'message~declined'], { cwd, cloud })
  assert('~ is a case-insensitive contains', parsedLines(contains.stdout).length === 1)
  const after = await runFsl(['--where', `timestamp>=${FIXED_NOW.toISOString()}`], { cwd, cloud })
  assert('>= on timestamp compares as time', parsedLines(after.stdout).length === 0)
}

async function testGroupByAndDistinct() {
  console.log('\nTest: --group-by with count, --distinct, and count alone')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const cloud = [
    ...Array.from({ length: 3 }, () => cloudEntry({ severity: 'ERROR', labels: { screen: 'Cart' } })),
    ...Array.from({ length: 5 }, () => cloudEntry({ severity: 'ERROR', labels: { screen: 'Pay' } })),
    cloudEntry({ severity: 'ERROR', labels: { screen: 'Home' } }),
  ]
  const grouped = await runFsl(['--where', 'severity=ERROR', '--group-by', 'labels.screen', '--select', 'labels.screen,count', '--order-by', 'count desc', '--limit', '2'], { cwd, cloud })
  const rows = parsedLines(grouped.stdout)
  assert('two rows, biggest first', rows.length === 2 && rows[0]['labels.screen'] === 'Pay' && rows[0].count === 5 && rows[1].count === 3, JSON.stringify(rows))
  assert('the limit cut one group and said so', grouped.stderr[0] === 'truncated: 2 shown, 1 more. Narrow with --where or raise --limit (max 1000).', grouped.stderr.join('|'))
  const distinct = await runFsl(['--distinct', 'labels.screen'], { cwd, cloud })
  assert('distinct values, sorted', parsedLines(distinct.stdout).map((r) => r['labels.screen']).join() === 'Cart,Home,Pay', distinct.stdout.join())
  const total = await runFsl(['--select', 'count'], { cwd, cloud })
  assert('count alone is one row', JSON.stringify(parsedLines(total.stdout)) === '[{"count":9}]', total.stdout.join())
  const extremes = await runFsl(['--select', 'min(timestamp),max(timestamp)'], { cwd, cloud })
  assert('min and max aggregate', parsedLines(extremes.stdout).length === 1 && 'min(timestamp)' in parsedLines(extremes.stdout)[0])
}

async function testLimitPrintsExactlyThatManyAndTheStderrLine() {
  console.log('\nTest: --limit 100 on 300 entries prints 100 lines and the stderr line')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const cloud = Array.from({ length: 300 }, (_, i) => cloudEntry({ minutesAgo: 1 + (i % 50), message: `entry ${i}` }))
  const run = await runFsl(['--limit', '100'], { cwd, cloud })
  assert('100 stdout lines', run.stdout.length === 100, String(run.stdout.length))
  assert('exactly one stderr line', run.stderr.length === 1, run.stderr.join('|'))
  assert('it is the truncation line', run.stderr[0] === 'truncated: 100 shown, 200 more. Narrow with --where or raise --limit (max 1000).', run.stderr[0])
  const byDefault = await runFsl([], { cwd, cloud })
  assert('the default limit is 100', byDefault.stdout.length === 100)
  const tooMany = await runFsl(['--limit', '1001'], { cwd, cloud })
  assert('over 1000 is refused', tooMany.code === 1 && tooMany.stderr[0].includes('1000'))
}

async function testUnknownFieldGivesFixItError() {
  console.log('\nTest: --where labels.screnn=x gets "Did you mean" and the schema pointer')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const cloud = [cloudEntry({ labels: { screen: 'Home' } })]
  const run = await runFsl(['--where', 'labels.screnn=x'], { cwd, cloud })
  const message = run.stderr.join('\n')
  assert('exits 1', run.code === 1)
  assert('Did you mean labels.screen?', message.includes('Did you mean labels.screen?'), message)
  assert('points at fsl logs schema', message.includes('fsl logs schema'), message)
  assert('lists the valid fields', message.includes('timestamp, severity, message'), message)
  assert('shows one example', message.includes('Example: fsl logs'), message)
  assert('prints nothing on stdout', run.stdout.length === 0)
  assert('the typo was not sent to the server as a filter', !run.cloudRequests[0].filter.includes('screnn'), run.cloudRequests[0].filter)
}

async function testUnknownFlagListsValidOnes() {
  console.log('\nTest: an unknown flag lists the valid flags and an example')
  const cwd = tempProject()
  const run = await runFsl(['--filter', 'severity=ERROR'], { cwd })
  const message = run.stderr.join('\n')
  assert('exits 1', run.code === 1)
  assert('names the flag', message.includes('Unknown flag --filter'))
  assert('lists valid flags', message.includes('--where') && message.includes('--group-by'))
  assert('shows an example', message.includes('Example: fsl logs'))
  assert('never reached the transport', run.cloudRequests.length === 0)
}

async function testSelectWithNoValuePrintsTheFieldList() {
  console.log('\nTest: --select with no value prints the field list')
  const cwd = tempProject()
  const run = await runFsl(['--select'], { cwd })
  assert('exits 0', run.code === 0)
  const text = run.stdout.join('\n')
  assert('lists entry fields and labels', text.includes('timestamp') && text.includes('labels.screen') && text.includes('jsonPayload.'))
  assert('no cloud read happened', run.cloudRequests.length === 0)
}

async function testNoProjectIsAClearError() {
  console.log('\nTest: no --project and no .firebaserc is an error that prints no id')
  const cwd = tempProject()
  const run = await runFsl([], { cwd })
  assert('exits 1', run.code === 1)
  assert('says how to name a project', run.stderr[0].includes('--project'))
}

async function testGcloudErrorsNeverPrintTheProject() {
  console.log('\nTest: a gcloud failure is shown without the project id')
  const cwd = tempProject()
  const deps = await runFslWithFailingCloud(cwd)
  assert('exits 1', deps.code === 1)
  assert('the failure is reported', deps.stderr[0].includes('gcloud failed'))
  assert('the project id is hidden', !deps.stderr.join('\n').includes(FAKE_PROJECT), deps.stderr.join('\n'))
}

async function runFslWithFailingCloud(cwd: string) {
  const stderr: string[] = []
  const code = await runLogs(['--project', FAKE_PROJECT], {
    readCloudEntries: async () => {
      throw new GcloudError(`gcloud failed: (gcloud.logging.read) PERMISSION_DENIED on projects/${FAKE_PROJECT}`)
    },
    runGcloud: async () => '',
    now: () => FIXED_NOW,
    cwd,
    env: {},
    printLine: () => {},
    printErrorLine: (line) => stderr.push(line),
  })
  return { code, stderr }
}

async function testRepeatsCountsTheTruth() {
  console.log('\nTest: --repeats prints copies, summaries and the true count')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const cloud = [
    ...Array.from({ length: 3 }, () => cloudEntry({ severity: 'ERROR', message: 'cart sync failed', labels: { repeatKey: 'RK1' } })),
    cloudEntry({ severity: 'WARNING', message: 'Repeated 197 more times', labels: { repeatOf: 'RK1', repeatCount: '197' } }),
    cloudEntry({ severity: 'ERROR', message: 'unrelated', labels: { repeatKey: 'RK2' } }),
  ]
  const run = await runFsl(['--repeats', 'RK1'], { cwd, cloud })
  const lines = parsedLines(run.stdout)
  assert('four entries and one total line', lines.length === 5, String(lines.length))
  const total = lines[lines.length - 1]
  assert('true count is 3 copies + 197', total.trueCount === 200, JSON.stringify(total))
  assert('the other error is not in it', !run.stdout.join('').includes('unrelated'))
  assert('the server filter names the key on both labels', run.cloudRequests[0].filter.includes('labels.repeatKey="RK1"') && run.cloudRequests[0].filter.includes('labels.repeatOf="RK1"'))
  assert('repeats look back 7 days by default', run.cloudRequests[0].filter.includes('2026-03-03T12:00:00.000Z'))
}

async function testServerFilterQuoting() {
  console.log('\nTest: values are quoted for the server, unknown labels are not sent')
  const filter = buildCloudFilter({
    since: FIXED_NOW,
    where: [
      { field: 'labels.screen', operator: '=', value: 'a"b\\c' },
      { field: 'labels.mystery', operator: '=', value: 'x' },
      { field: 'severity', operator: '=', value: 'error' },
      { field: 'message', operator: '~', value: 'x' },
    ],
    knownLabelKeys: new Set(['screen']),
  })
  assert('quote and backslash are escaped', filter.includes('labels.screen="a\\"b\\\\c"'), filter)
  assert('an unconfirmed label stays client-side', !filter.includes('mystery'))
  assert('severity is upper-cased', filter.includes('severity="ERROR"'))
  assert('contains is never sent', !filter.includes('message'))
}

async function testAttachments() {
  console.log('\nTest: attachments lists and downloads through gcloud storage')
  const cwd = tempProject()
  const run = await runFsl(['attachments', '01JABC'], {
    cwd,
    env: { FIREBASE_STORAGE_BUCKET: FAKE_BUCKET },
    gcloudOutput: (args) => (args[1] === 'ls' ? `gs://${FAKE_BUCKET}/logAttachments/01JABC/screenshot.png\ngs://${FAKE_BUCKET}/logAttachments/01JABC/state.json\n` : ''),
  })
  assert('exits 0', run.code === 0, run.stderr.join('\n'))
  assert('prints each file with where it went', parsedLines(run.stdout).map((r) => r.name).join() === 'screenshot.png,state.json', run.stdout.join())
  assert('listed, then copied', run.gcloudCalls[0][1] === 'ls' && run.gcloudCalls[1][1] === 'cp')
  assert('into .fsl-logs/attachments/<logId>/', fs.existsSync(path.join(cwd, '.fsl-logs', 'attachments', '01JABC')))
  assert('the bucket is never printed', !run.stdout.concat(run.stderr).join('\n').includes(FAKE_BUCKET))
  const noBucket = await runFsl(['attachments', '01JABC'], { cwd })
  assert('no bucket is an error', noBucket.code === 1 && noBucket.stderr[0].includes('--bucket'))
  const badId = await runFsl(['attachments', '../etc'], { cwd, env: { FIREBASE_STORAGE_BUCKET: FAKE_BUCKET } })
  assert('a logId that is not an id is refused', badId.code === 1)
}

async function testNoLocalFolderIsAnError() {
  console.log('\nTest: --local without .fsl-logs/ says where the files come from')
  const run = await runFsl(['--local'], { cwd: tempProject() })
  assert('exits 1', run.code === 1)
  assert('names the folder and the option', run.stderr[0].includes('.fsl-logs') && run.stderr[0].includes('logLocalDir'))
}

async function main() {
  await testBothSourcesNormaliseToOneShape()
  await testGcloudOutputIsParsedAsOneArray()
  await testWhereSelectAndOrder()
  await testOperators()
  await testGroupByAndDistinct()
  await testLimitPrintsExactlyThatManyAndTheStderrLine()
  await testUnknownFieldGivesFixItError()
  await testUnknownFlagListsValidOnes()
  await testSelectWithNoValuePrintsTheFieldList()
  await testNoProjectIsAClearError()
  await testGcloudErrorsNeverPrintTheProject()
  await testRepeatsCountsTheTruth()
  await testServerFilterQuoting()
  await testAttachments()
  await testNoLocalFolderIsAnError()
  reportResults()
}

main()
