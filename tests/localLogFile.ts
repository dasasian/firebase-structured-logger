/**
 * The backend writes dev.jsonl into logLocalDir in development, on any server, and
 * only there. The logger reads FUNCTIONS_EMULATOR, K_SERVICE and NODE_ENV when its
 * module loads, so each case starts tests/localLogFileApp.ts as its own process with the
 * environment under test, and this suite reads what that process wrote and printed.
 *
 * Run: npx tsx tests/localLogFile.ts
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { assert, reportResults } from './testHelpers.js'
import { runFsl, tempProject } from './logsHelpers.js'

const APP = path.join(process.cwd(), 'tests', 'localLogFileApp.ts')
const STAGED_VARIABLES = ['FUNCTIONS_EMULATOR', 'K_SERVICE', 'NODE_ENV']

interface Environment {
  name: string
  variables: Record<string, string>
}

const DEVELOPMENT: Environment = { name: 'development', variables: {} }
const NODE_ENV_DEVELOPMENT: Environment = { name: 'NODE_ENV=development', variables: { NODE_ENV: 'development' } }
const CLOUD_RUN: Environment = { name: 'K_SERVICE set', variables: { K_SERVICE: 'my-service' } }
const PRODUCTION_NODE_ENV: Environment = { name: 'NODE_ENV=production', variables: { NODE_ENV: 'production' } }
const EMULATOR: Environment = { name: 'emulator', variables: { FUNCTIONS_EMULATOR: 'true' } }
const EMULATOR_WITH_K_SERVICE: Environment = { name: 'emulator with K_SERVICE set', variables: { FUNCTIONS_EMULATOR: 'true', K_SERVICE: 'my-service' } }
const EMULATOR_WITH_PRODUCTION_NODE_ENV: Environment = { name: 'emulator with NODE_ENV=production', variables: { FUNCTIONS_EMULATOR: 'true', NODE_ENV: 'production' } }

interface Ran {
  cwd: string
  logDir: string
  stdout: string
  stderr: string
}

function withoutLogIds(text: string): string {
  return text.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, 'LOGID')
}

function runApp(environment: Environment, scenario: string, options: { withLogLocalDir: boolean }): Ran {
  const cwd = tempProject()
  const logDir = path.join(cwd, '.fsl-logs')
  const env = { ...process.env }
  for (const name of STAGED_VARIABLES) delete env[name]
  Object.assign(env, environment.variables)
  const child = spawnSync('npx', ['tsx', APP, scenario, options.withLogLocalDir ? logDir : '-'], { cwd, env, encoding: 'utf-8' })
  if (child.status !== 0) throw new Error(`${environment.name}/${scenario} exited ${child.status}: ${child.stderr}`)
  return { cwd, logDir, stdout: withoutLogIds(child.stdout), stderr: withoutLogIds(child.stderr) }
}

function entriesInFile(ran: Ran): Record<string, any>[] {
  const file = path.join(ran.logDir, 'dev.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
}

async function testDevelopmentWritesTheFileFsLogsReads() {
  console.log('\nTest: off the emulator, in development, the entry is in dev.jsonl and fsl logs --local returns it')
  for (const environment of [DEVELOPMENT, NODE_ENV_DEVELOPMENT]) {
    const ran = runApp(environment, 'direct', { withLogLocalDir: true })
    const [entry] = entriesInFile(ran)
    assert(`${environment.name}: one entry in the file`, entriesInFile(ran).length === 1)
    assert(`${environment.name}: it has the emulator branch's shape`, entry?.severity === 'ERROR' && entry.message === 'cart sync failed' && entry.labels.screen === 'Cart' && entry.jsonPayload.error.message === 'boom' && typeof entry.timestamp === 'string' && !('logging.googleapis.com/labels' in entry))
    assert(`${environment.name}: the folder ignores itself`, fs.readFileSync(path.join(ran.logDir, '.gitignore'), 'utf-8') === '*\n')

    const read = await runFsl(['--local', '--where', 'severity=ERROR', '--select', 'severity,message,labels.screen,labels.userId'], { cwd: ran.cwd })
    assert(`${environment.name}: fsl logs --local exits 0`, read.code === 0, read.stderr.join('\n'))
    assert(`${environment.name}: it returns the entry with severity, message and labels`, read.stdout.length === 1 && read.stdout[0] === '{"severity":"ERROR","message":"cart sync failed","labels.screen":"Cart","labels.userId":"u1"}', read.stdout.join('\n'))
  }
}

async function testADeployedOrProductionProcessWritesNoFile() {
  console.log('\nTest: with K_SERVICE set, or NODE_ENV=production, there is no file and no folder')
  for (const environment of [CLOUD_RUN, PRODUCTION_NODE_ENV]) {
    const ran = runApp(environment, 'direct', { withLogLocalDir: true })
    assert(`${environment.name}: no folder`, !fs.existsSync(ran.logDir), fs.existsSync(ran.logDir) ? fs.readdirSync(ran.logDir).join(',') : '')
    assert(`${environment.name}: the entry was still printed`, ran.stderr.includes('"message":"cart sync failed"'), ran.stderr)
  }
}

async function testNoLogLocalDirWritesNothingAnywhere() {
  console.log('\nTest: with no logLocalDir no file is written, in any environment')
  for (const environment of [DEVELOPMENT, CLOUD_RUN, PRODUCTION_NODE_ENV, EMULATOR, EMULATOR_WITH_K_SERVICE]) {
    const ran = runApp(environment, 'direct', { withLogLocalDir: false })
    assert(`${environment.name}: the working folder holds nothing`, fs.readdirSync(ran.cwd).length === 0, fs.readdirSync(ran.cwd).join(','))
  }
}

async function testTheEmulatorIsUnchangedByTheNewFacts() {
  console.log('\nTest: inside the emulator, K_SERVICE and NODE_ENV=production change neither the file nor the output')
  const plain = runApp(EMULATOR, 'direct', { withLogLocalDir: true })
  assert('the emulator prints the console line, not the production JSON', (plain.stdout + plain.stderr).includes('[ERROR] cart sync failed') && !(plain.stdout + plain.stderr).includes('logging.googleapis.com'), plain.stderr)
  for (const environment of [EMULATOR, EMULATOR_WITH_K_SERVICE, EMULATOR_WITH_PRODUCTION_NODE_ENV]) {
    const ran = runApp(environment, 'direct', { withLogLocalDir: true })
    assert(`${environment.name}: the file has the entry`, entriesInFile(ran).length === 1 && entriesInFile(ran)[0].message === 'cart sync failed')
    assert(`${environment.name}: stdout is what the plain emulator prints`, ran.stdout === plain.stdout, ran.stdout)
    assert(`${environment.name}: stderr is what the plain emulator prints`, ran.stderr === plain.stderr, ran.stderr)
  }
}

async function testOffTheEmulatorOnlyTheFileIsNew() {
  console.log('\nTest: off the emulator, stdout and stderr are the same bytes with and without logLocalDir')
  for (const scenario of ['direct', 'callable', 'http']) {
    const without = runApp(DEVELOPMENT, scenario, { withLogLocalDir: false })
    const withDir = runApp(DEVELOPMENT, scenario, { withLogLocalDir: true })
    const printed = withDir.stdout + withDir.stderr
    assert(`${scenario}: the process printed the production JSON`, printed.includes('"logging.googleapis.com/labels"') && printed.includes('"message":"cart sync failed"'), printed)
    assert(`${scenario}: stdout is identical`, withDir.stdout === without.stdout, `${withDir.stdout} vs ${without.stdout}`)
    assert(`${scenario}: stderr is identical`, withDir.stderr === without.stderr, `${withDir.stderr} vs ${without.stderr}`)
  }
}

async function testRotationAndTheRecordLimitWorkOffTheEmulator() {
  console.log('\nTest: past the record limit a rotated file appears')
  const ran = runApp(DEVELOPMENT, 'rotation', { withLogLocalDir: true })
  const rotated = fs.readdirSync(ran.logDir).filter((name) => /^dev-.*\.jsonl$/.test(name))
  assert('one rotated file', rotated.length === 1, fs.readdirSync(ran.logDir).join(','))
  assert('it holds the first two entries', rotated.length === 1 && fs.readFileSync(path.join(ran.logDir, rotated[0]), 'utf-8').trim().split('\n').length === 2)
  assert('the current file holds the third', entriesInFile(ran).length === 1 && entriesInFile(ran)[0].message === 'entry 2')
}

async function testEntriesFromClientsReachTheFileToo() {
  console.log('\nTest: an entry a client sent through either handler is in the file')
  for (const scenario of ['callable', 'http']) {
    const ran = runApp(DEVELOPMENT, scenario, { withLogLocalDir: true })
    const [entry] = entriesInFile(ran)
    assert(`${scenario}: the file has the entry`, entriesInFile(ran).length === 1 && entry.message === 'cart sync failed' && entry.severity === 'ERROR' && entry.labels.screen === 'Cart')
    const deployed = runApp(CLOUD_RUN, scenario, { withLogLocalDir: true })
    assert(`${scenario}: with K_SERVICE set there is no file`, !fs.existsSync(deployed.logDir))
  }
}

async function main() {
  await testDevelopmentWritesTheFileFsLogsReads()
  await testADeployedOrProductionProcessWritesNoFile()
  await testNoLogLocalDirWritesNothingAnywhere()
  await testTheEmulatorIsUnchangedByTheNewFacts()
  await testOffTheEmulatorOnlyTheFileIsNew()
  await testRotationAndTheRecordLimitWorkOffTheEmulator()
  await testEntriesFromClientsReachTheFileToo()
  reportResults()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
