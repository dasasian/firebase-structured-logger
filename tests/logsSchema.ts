/**
 * `fsl logs schema`: counts for every label, samples only where a sample is not a person,
 * and a `--add` that survives `--refresh`. Fake transport, temp folders.
 *
 * Run: npx tsx tests/logsSchema.ts
 */

import fs from 'fs'
import path from 'path'
import { assert, reportResults } from './testHelpers.js'
import { cloudEntry, runFsl, tempProject, withFirebaserc } from './logsHelpers.js'

interface SchemaJson {
  fromLogs: { labels: Record<string, { count: number; samples: string[] }>; entriesRead: number }
  fromCode: Record<string, { meaning?: string }>
}

function schemaOf(stdout: string[]): SchemaJson {
  return JSON.parse(stdout[0]) as SchemaJson
}

const personalLabelEntries = [
  cloudEntry({ labels: { userId: 'u_1', email: 'a@b.co', venueId: 'v_10', userName: 'Ada', phoneNumber: '555' } }),
  cloudEntry({ labels: { userId: 'u_2', email: 'c@d.co', venueId: 'v_11', userName: 'Bo', phoneNumber: '556' } }),
  cloudEntry({ labels: { venueId: 'v_10' } }),
]

async function testCountsForAllSamplesOnlyForVenueId() {
  console.log('\nTest: userId, email and venueId are counted; only venueId has samples')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const run = await runFsl(['schema', '--json'], { cwd, cloud: personalLabelEntries })
  const { fromLogs } = schemaOf(run.stdout)
  assert('exits 0', run.code === 0, run.stderr.join('\n'))
  assert('userId counted', fromLogs.labels.userId.count === 2)
  assert('email counted', fromLogs.labels.email.count === 2)
  assert('venueId counted', fromLogs.labels.venueId.count === 3)
  assert('venueId has its samples, once each', fromLogs.labels.venueId.samples.join() === 'v_10,v_11', fromLogs.labels.venueId.samples.join())
  assert('userId has none', fromLogs.labels.userId.samples.length === 0)
  assert('email has none', fromLogs.labels.email.samples.length === 0)
  assert('a name key has none', fromLogs.labels.userName.samples.length === 0)
  assert('a phone key has none', fromLogs.labels.phoneNumber.samples.length === 0)
  assert('appId is counted from every entry', fromLogs.labels.appId.count === 3)
  assert('the read asked for 500 entries over 7 days', run.cloudRequests[0].limit === 500 && run.cloudRequests[0].filter.includes('2026-03-03T12:00:00.000Z'), run.cloudRequests[0].filter)
}

async function testSamplesAreCappedAtThreeAndForty() {
  console.log('\nTest: at most three samples, each cut to 40 characters')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const cloud = ['a', 'b', 'c', 'd'].map((v) => cloudEntry({ labels: { tag: v.repeat(60) } }))
  const { fromLogs } = schemaOf((await runFsl(['schema', '--json'], { cwd, cloud })).stdout)
  assert('three samples', fromLogs.labels.tag.samples.length === 3)
  assert('forty characters each', fromLogs.labels.tag.samples.every((s) => s.length === 40))
}

async function testAddSurvivesRefresh() {
  console.log('\nTest: --add survives --refresh, --remove drops it')
  const cwd = tempProject()
  withFirebaserc(cwd)
  await runFsl(['schema', '--add', 'tableId', 'the table an order is for', '--add', 'seatId'], { cwd, cloud: personalLabelEntries })
  const refreshed = await runFsl(['schema', '--refresh', '--json'], { cwd, cloud: [cloudEntry({ labels: { screen: 'Home' } })] })
  const after = schemaOf(refreshed.stdout)
  assert('--refresh re-read the logs', after.fromLogs.labels.screen?.count === 1 && after.fromLogs.labels.venueId === undefined)
  assert('tableId kept with its meaning', after.fromCode.tableId?.meaning === 'the table an order is for', JSON.stringify(after.fromCode))
  assert('seatId kept with no meaning', 'seatId' in after.fromCode)
  const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, '.fsl-logs', 'schema.json'), 'utf-8')) as SchemaJson
  assert('the file holds both parts', onDisk.fromLogs !== undefined && onDisk.fromCode.tableId !== undefined)
  const removed = await runFsl(['schema', '--remove', 'tableId', '--json'], { cwd })
  assert('--remove drops it', schemaOf(removed.stdout).fromCode.tableId === undefined && 'seatId' in schemaOf(removed.stdout).fromCode)
}

async function testHumanOutputNamesTheSourceOnEachLine() {
  console.log('\nTest: the text output says [logs] or [code] on every line')
  const cwd = tempProject()
  withFirebaserc(cwd)
  const run = await runFsl(['schema', '--add', 'tableId', 'the table'], { cwd, cloud: personalLabelEntries })
  assert('every line has a source', run.stdout.length > 0 && run.stdout.every((line) => line.includes('[logs]') || line.includes('[code]')), run.stdout.join('\n'))
  assert('the venueId line shows its samples', run.stdout.some((line) => line.startsWith('labels.venueId') && line.includes('v_10')))
  assert('the userId line shows none', run.stdout.some((line) => line.startsWith('labels.userId') && !line.includes('samples')))
  assert('the code line carries its meaning', run.stdout.some((line) => line.includes('[code]') && line.includes('the table')))
}

async function testCacheIsUsedForADayThenRefreshed() {
  console.log('\nTest: a day-old cache is reused; --refresh and another source re-read')
  const cwd = tempProject()
  withFirebaserc(cwd)
  await runFsl(['schema'], { cwd, cloud: personalLabelEntries })
  const again = await runFsl(['schema'], { cwd, cloud: personalLabelEntries })
  assert('no second read inside a day', again.cloudRequests.length === 0)
  const forced = await runFsl(['schema', '--refresh'], { cwd, cloud: personalLabelEntries })
  assert('--refresh reads again', forced.cloudRequests.length === 1)
  const file = path.join(cwd, '.fsl-logs', 'schema.json')
  const cache = JSON.parse(fs.readFileSync(file, 'utf-8')) as { fromLogs: { readAt: string } }
  cache.fromLogs.readAt = '2026-03-08T12:00:00.000Z'
  fs.writeFileSync(file, JSON.stringify(cache))
  const stale = await runFsl(['schema'], { cwd, cloud: personalLabelEntries })
  assert('a cache older than a day is re-read', stale.cloudRequests.length === 1)
}

async function testSchemaLabelsBecomeValidQueryFields() {
  console.log('\nTest: a label found by schema is accepted by a query and sent to the server')
  const cwd = tempProject()
  withFirebaserc(cwd)
  await runFsl(['schema'], { cwd, cloud: personalLabelEntries })
  const run = await runFsl(['--where', 'labels.venueId=v_10'], { cwd, cloud: [] })
  assert('accepted', run.code === 0, run.stderr.join('\n'))
  assert('pushed to the server', run.cloudRequests[0].filter.includes('labels.venueId="v_10"'))
}

async function main() {
  await testCountsForAllSamplesOnlyForVenueId()
  await testSamplesAreCappedAtThreeAndForty()
  await testAddSurvivesRefresh()
  await testHumanOutputNamesTheSourceOnEachLine()
  await testCacheIsUsedForADayThenRefreshed()
  await testSchemaLabelsBecomeValidQueryFields()
  reportResults()
}

main()
