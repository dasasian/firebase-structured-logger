/**
 * `fsl logs` reads the entries fsl wrote unless `--all` asks for every line, says "not known"
 * after a scan that stopped at its limit, and refuses a word it does not know.
 * The filter is read from the requests the fake transport recorded; whether Cloud Logging
 * reads `labels.appId:*` as "has the label" needs a real project.
 *
 * Run: npx tsx tests/logsEntriesFslWrote.ts
 */

import fs from 'fs'
import path from 'path'
import { assert, reportResults } from './testHelpers.js'
import { cloudEntry, runFsl, tempProject, withFirebaserc } from './logsHelpers.js'
import { MAX_CLOUD_ENTRIES } from '../src/tools/logs/command.js'

const APP_ID_TERM = '(labels.appId:* OR jsonPayload.labels.appId:*)'
const ALL_HINT = '--all also reads lines fsl did not write.'

function projectWithFirebaserc(): string {
  const cwd = tempProject()
  withFirebaserc(cwd)
  return cwd
}

async function testDefaultQueryAsksForTheAppIdLabel() {
  console.log('\nTest: a default query, schema and --repeats ask for entries that carry appId; --all does not')
  const cwd = projectWithFirebaserc()
  const query = await runFsl(['--since', '2h'], { cwd, cloud: [] })
  assert('the exact default filter', query.cloudRequests[0].filter ===
    '(resource.type="cloud_function" OR resource.type="cloud_run_revision") AND NOT logName:"cloudaudit.googleapis.com" AND timestamp>="2026-03-10T10:00:00.000Z" AND ' + APP_ID_TERM, query.cloudRequests[0].filter)
  const all = await runFsl(['--since', '2h', '--all'], { cwd, cloud: [] })
  assert('--all leaves the term out', !all.cloudRequests[0].filter.includes('appId'), all.cloudRequests[0].filter)
  assert('--all keeps the rest of the filter', all.cloudRequests[0].filter.includes('resource.type="cloud_run_revision"') && all.cloudRequests[0].filter.includes('timestamp>='))
  const schema = await runFsl(['schema', '--refresh'], { cwd, cloud: [] })
  assert('schema asks for appId', schema.cloudRequests[0].filter.includes(APP_ID_TERM), schema.cloudRequests[0].filter)
  const repeats = await runFsl(['--repeats', 'RK1'], { cwd, cloud: [] })
  assert('--repeats asks for appId', repeats.cloudRequests[0].filter.includes(APP_ID_TERM), repeats.cloudRequests[0].filter)
  const repeatsAll = await runFsl(['--repeats', 'RK1', '--all'], { cwd, cloud: [] })
  assert('--repeats --all leaves it out', !repeatsAll.cloudRequests[0].filter.includes('appId'), repeatsAll.cloudRequests[0].filter)
}

async function testNoRowsNamesAllOnlyWhenItWouldHelp() {
  console.log('\nTest: a cloud query with no rows names --all; --all and --local do not')
  const cwd = projectWithFirebaserc()
  const plain = await runFsl([], { cwd, cloud: [] })
  assert('one line that names --all', plain.stderr.length === 1 && plain.stderr[0] === `0 entries matched in the last 1h. ${ALL_HINT}`, plain.stderr.join('\n'))
  const all = await runFsl(['--all'], { cwd, cloud: [] })
  assert('--all: the plain line', all.stderr.join('\n') === '0 entries matched in the last 1h.', all.stderr.join('\n'))
  const local = tempProject()
  fs.mkdirSync(path.join(local, '.fsl-logs'))
  const localRun = await runFsl(['--local'], { cwd: local })
  assert('--local: the plain line, no hint', localRun.stderr.join('\n') === '0 entries matched in .fsl-logs/*.jsonl in the last 1h.', localRun.stderr.join('\n'))
}

async function testAllWithLocalIsRefused() {
  console.log('\nTest: --all with --local is refused with a reason')
  const run = await runFsl(['--all', '--local'], { cwd: projectWithFirebaserc(), cloud: [] })
  assert('exits 1', run.code === 1)
  assert('says why', run.stderr[0].includes('--all') && run.stderr[0].includes('--local') && run.stderr[0].includes('Cloud Logging'), run.stderr.join('\n'))
  assert('reads nothing', run.cloudRequests.length === 0 && run.stdout.length === 0)
}

function unrelatedEntries(count: number) {
  return Array.from({ length: count }, () => cloudEntry({ message: 'GET /health' }))
}

async function testCutScanWithNoRowsIsNotKnown() {
  console.log('\nTest: a scan at its limit with no rows says "not known", never "0 matched"')
  const cwd = projectWithFirebaserc()
  const cut = await runFsl(['--where', 'message~timeout', '--since', '7d'], { cwd, cloud: unrelatedEntries(MAX_CLOUD_ENTRIES) })
  const text = cut.stderr.join('\n')
  assert('exit 0', cut.code === 0)
  assert('one line', cut.stderr.length === 1, text)
  assert('says it is not known and how many were read', text.startsWith('Not known whether anything matched in the last 7d:') && text.includes(`newest ${MAX_CLOUD_ENTRIES} entries`), text)
  assert('says older entries were not read and how to narrow', text.includes('older entries were not read') && text.includes('Narrow with --since or --where'), text)
  assert('names --all, once', text.includes(ALL_HINT), text)
  assert('neither of the two old lines', !text.includes('scanned:') && !text.includes('0 entries matched'), text)
  const cutAll = await runFsl(['--where', 'message~timeout', '--all'], { cwd, cloud: unrelatedEntries(MAX_CLOUD_ENTRIES) })
  assert('--all: one line, without the hint', cutAll.stderr.length === 1 && cutAll.stderr[0].startsWith('Not known') && !cutAll.stderr[0].includes('--all'), cutAll.stderr.join('\n'))
  const grouped = await runFsl(['--distinct', 'labels.releaseId', '--since', '7d'], { cwd, cloud: unrelatedEntries(MAX_CLOUD_ENTRIES) })
  assert('a distinct over nothing found is the same line', grouped.stderr.length === 1 && grouped.stderr[0].startsWith('Not known'), grouped.stderr.join('\n'))
  const repeats = await runFsl(['--repeats', 'RK1'], { cwd, cloud: unrelatedEntries(MAX_CLOUD_ENTRIES) })
  assert('--repeats: not known, and no "scanned" line', repeats.stderr.length === 1 && repeats.stderr[0].startsWith('Not known'), repeats.stderr.join('\n'))
}

async function testScanBelowTheLimitStillSaysZeroMatched() {
  console.log('\nTest: a scan below its limit with no rows says "0 matched"')
  const cwd = projectWithFirebaserc()
  const run = await runFsl(['--where', 'message~timeout'], { cwd, cloud: unrelatedEntries(MAX_CLOUD_ENTRIES - 1) })
  assert('the zero line, with the hint', run.stderr.join('\n') === `0 entries matched in the last 1h. ${ALL_HINT}`, run.stderr.join('\n'))
}

async function testCutScanWithRowsKeepsTheScannedLine() {
  console.log('\nTest: a scan at its limit with rows keeps the "scanned" line')
  const cwd = projectWithFirebaserc()
  const cloud = [...unrelatedEntries(MAX_CLOUD_ENTRIES - 1), cloudEntry({ message: 'timeout reading cart' })]
  const run = await runFsl(['--where', 'message~timeout'], { cwd, cloud })
  assert('one row', run.stdout.length === 1)
  assert('the scanned line, and no not-known line', run.stderr.length === 1 && run.stderr[0].startsWith('scanned: only the newest'), run.stderr.join('\n'))
}

async function testAWordTheCommandDoesNotKnowIsAnError() {
  console.log('\nTest: a stray word ends the run with exit 1')
  const cwd = projectWithFirebaserc()
  const misplaced = await runFsl(['--local', 'schema'], { cwd })
  assert('schema after a flag: exit 1', misplaced.code === 1)
  assert('shows the correct form with the user\'s flag', misplaced.stderr.join('\n').includes('fsl logs schema --local'), misplaced.stderr.join('\n'))
  assert('prints nothing on stdout', misplaced.stdout.length === 0)
  const withProject = await runFsl(['--where', 'severity=ERROR', '--project', 'p1', 'schema'], { cwd, cloud: [] })
  assert('keeps the flags schema accepts and drops the rest', withProject.stderr.join('\n').includes('Correct form: fsl logs schema --project p1') && !withProject.stderr.join('\n').includes('--where'), withProject.stderr.join('\n'))
  assert('reads nothing', withProject.cloudRequests.length === 0)
  const attachments = await runFsl(['--since', '2h', 'attachments', '01JABC'], { cwd })
  assert('attachments after a flag shows its form with the logId', attachments.code === 1 && attachments.stderr.join('\n').includes('Correct form: fsl logs attachments 01JABC'), attachments.stderr.join('\n'))
  const nonsense = await runFsl(['--local', 'nonsense'], { cwd })
  const text = nonsense.stderr.join('\n')
  assert('any other word: exit 1', nonsense.code === 1)
  assert('names both sub-commands and gives an example', text.includes('schema') && text.includes('attachments') && text.includes('Example: fsl logs schema --local') && text.includes('"nonsense"'), text)
}

async function testSubcommandsRefuseAStrayWordToo() {
  console.log('\nTest: schema and attachments refuse a stray word, and still take their own words')
  const cwd = projectWithFirebaserc()
  const schema = await runFsl(['schema', 'nonsense', '--local'], { cwd })
  assert('schema: exit 1 naming the word', schema.code === 1 && schema.stderr[0].includes('"nonsense"'), schema.stderr.join('\n'))
  const meaning = await runFsl(['schema', '--local', '--add', 'venueId', 'the', 'venue'], { cwd })
  assert('an unquoted meaning leaves a word over: exit 1 with the quoted example', meaning.code === 1 && meaning.stderr[0].includes('"the venue the order belongs to"'), meaning.stderr.join('\n'))
  const quoted = await runFsl(['schema', '--add', 'venueId', 'the venue', '--remove', 'old', '--json'], { cwd, cloud: [] })
  assert('--add name "meaning" and --remove name are not stray words', quoted.code === 0, quoted.stderr.join('\n'))
  const attachments = await runFsl(['attachments', '01JABC', 'extra'], { cwd, env: { FIREBASE_STORAGE_BUCKET: 'b' } })
  assert('attachments: a second word is refused', attachments.code === 1 && attachments.stderr[0].includes('"extra"') && attachments.gcloudCalls.length === 0, attachments.stderr.join('\n'))
  const fine = await runFsl(['attachments', '01JABC'], { cwd, env: { FIREBASE_STORAGE_BUCKET: 'b' } })
  assert('attachments with its logId still runs', fine.code === 0 && fine.gcloudCalls.length > 0, fine.stderr.join('\n'))
}

async function main() {
  await testDefaultQueryAsksForTheAppIdLabel()
  await testNoRowsNamesAllOnlyWhenItWouldHelp()
  await testAllWithLocalIsRefused()
  await testCutScanWithNoRowsIsNotKnown()
  await testScanBelowTheLimitStillSaysZeroMatched()
  await testCutScanWithRowsKeepsTheScannedLine()
  await testAWordTheCommandDoesNotKnowIsAnError()
  await testSubcommandsRefuseAStrayWordToo()
  reportResults()
}

main()
