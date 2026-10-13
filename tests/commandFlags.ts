/**
 * A flag's value comes after `=` or after a space in `fsl doctor`, `fsl upload-sourcemaps`
 * and `fsl install-skills` (#95). The parser is checked on its own for every value flag, and
 * the CLI is run as a real process for what a person types.
 *
 * `--bucket` and `--prefix` reach Cloud Storage and nothing else, so they are checked at the
 * parser only; the process runs here embed maps and touch no network.
 *
 * Run: npx tsx tests/commandFlags.ts
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { assert, reportResults } from './testHelpers.js'
import { parseCommandFlags, UPLOAD_FLAGS } from '../src/tools/commandFlags.js'
import { EMBEDDED_RELEASE_MARKER } from '../src/tools/uploadSourceMaps.js'

const CLI = path.join(process.cwd(), 'src', 'tools', 'index.ts')

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync('npx', ['tsx', CLI, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-command-flags-'))
}

function backendFolder(root: string, name: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true })
  fs.writeFileSync(path.join(root, name, 'package.json'), JSON.stringify({ name, engines: { node: '>=22' } }))
}

function testEveryValueFlagInBothForms() {
  console.log('\nTest: each upload-sourcemaps value flag reads = and a space')
  for (const name of UPLOAD_FLAGS.valueFlags) {
    const withEquals = parseCommandFlags([`--${name}=some-value`], UPLOAD_FLAGS)
    const withSpace = parseCommandFlags([`--${name}`, 'some-value'], UPLOAD_FLAGS)
    assert(`--${name}=some-value`, withEquals.values[name] === 'some-value', JSON.stringify(withEquals.values))
    assert(`--${name} some-value`, withSpace.values[name] === 'some-value', JSON.stringify(withSpace.values))
  }
}

function testValueFlagWithNoValueThrows() {
  console.log('\nTest: a value flag with no value throws and never reads as "true"')
  for (const argv of [['--bucket'], ['--bucket', '--embed-sourcemaps'], ['--embed-sourcemaps', '--prefix']]) {
    let message = ''
    try {
      parseCommandFlags(argv, UPLOAD_FLAGS)
    } catch (err) {
      message = (err as Error).message
    }
    assert(`${argv.join(' ')}: throws`, message.includes('needs a value'), message)
    assert(`${argv.join(' ')}: shows the example`, message.includes('Example: fsl upload-sourcemaps'), message)
  }
}

function testSwitchLeavesTheNextWord() {
  console.log('\nTest: a switch does not take the next word as its value')
  const parsed = parseCommandFlags(['--embed-sourcemaps', 'stray', '--release', 'r1'], UPLOAD_FLAGS)
  assert('the switch is on', parsed.switches.has('embed-sourcemaps'))
  assert('the word is not its value', parsed.values['embed-sourcemaps'] === undefined)
  assert('the next flag still reads its value', parsed.values.release === 'r1')
}

function testDoctorSpaceFormEqualsEqualsForm() {
  console.log('\nTest: fsl doctor --backend backend --dist frontend/dist reports what the = form does')
  const root = tempRoot()
  backendFolder(root, 'backend')
  fs.mkdirSync(path.join(root, 'frontend', 'dist'), { recursive: true })
  const spaced = runCli(root, ['doctor', '--backend', 'backend', '--dist', 'frontend/dist', '--json'])
  const joined = runCli(root, ['doctor', '--backend=backend', '--dist=frontend/dist', '--json'])
  assert('exit 0 with the space form', spaced.status === 0, `${spaced.status} ${spaced.stderr}`)
  assert('the space form reads the backend folder', spaced.stdout.includes('"backend":"./backend"'), spaced.stdout)
  assert('the space form reads the web build folder', spaced.stdout.includes('"dist":"./frontend/dist"'), spaced.stdout)
  assert('same report as the = form', spaced.stdout === joined.stdout, `${spaced.stdout}\n${joined.stdout}`)
  assert('no folder named true in the report', !spaced.stdout.includes('true/') && !spaced.stdout.includes('./true'), spaced.stdout)
  fs.rmSync(root, { recursive: true, force: true })
}

function testDoctorValueFlagWithNoValue() {
  console.log('\nTest: fsl doctor --backend with no value exits 1 and shows the correct form')
  const root = tempRoot()
  for (const args of [['--backend'], ['--backend', '--json'], ['--dist']]) {
    const run = runCli(root, ['doctor', ...args])
    assert(`${args.join(' ')}: exit 1`, run.status === 1, String(run.status))
    assert(`${args.join(' ')}: says the flag needs a value`, run.stderr.includes(`${args[0]} needs a value`), run.stderr)
    assert(`${args.join(' ')}: shows a doctor example`, run.stderr.includes('Example: fsl doctor --backend backend'), run.stderr)
    assert(`${args.join(' ')}: prints no report`, run.stdout === '', run.stdout)
    assert(`${args.join(' ')}: no stack trace`, !/^\s+at /m.test(run.stderr), run.stderr)
  }
  fs.rmSync(root, { recursive: true, force: true })
}

function testDoctorSwitchKeepsTheWord() {
  console.log('\nTest: fsl doctor --json backend keeps --json a switch and ignores the word')
  const root = tempRoot()
  backendFolder(root, 'backend')
  const run = runCli(root, ['doctor', '--json', 'backend'])
  assert('exit 0', run.status === 0, `${run.status} ${run.stderr}`)
  assert('the output is JSON', run.stdout.trim().startsWith('{'), run.stdout)
  assert('the word named no backend', run.stdout.includes('"backend":null'), run.stdout)
  fs.rmSync(root, { recursive: true, force: true })
}

function testDoctorStrictKeepsTheWord() {
  console.log('\nTest: fsl doctor --strict --backend backend keeps --strict a switch')
  const root = tempRoot()
  backendFolder(root, 'backend')
  const run = runCli(root, ['doctor', '--strict', '--backend', 'backend'])
  assert('exit 0', run.status === 0, `${run.status} ${run.stdout} ${run.stderr}`)
  assert('the backend was read', run.stdout.includes('backend in ./backend'), run.stdout)
  fs.rmSync(root, { recursive: true, force: true })
}

function embedProject(): { root: string } {
  const root = tempRoot()
  fs.mkdirSync(path.join(root, 'web', 'out'), { recursive: true })
  fs.writeFileSync(path.join(root, 'web', 'out', 'app-abc.js.map'), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }))
  return { root }
}

function testUploadSourcemapsSpaceForm() {
  console.log('\nTest: fsl upload-sourcemaps reads --backend, --dist and --release after a space')
  const { root } = embedProject()
  const run = runCli(root, ['upload-sourcemaps', '--embed-sourcemaps', '--release', 'r7', '--backend', 'srv', '--dist', 'web/out'])
  assert('exit 0', run.status === 0, `${run.status} ${run.stderr.slice(0, 300)}`)
  const embedded = path.join(root, 'srv', 'sourcemaps', 'current')
  assert('the map went under the backend folder', fs.existsSync(path.join(embedded, 'app-abc.js.map')))
  assert('the marker names the release', fs.readFileSync(path.join(embedded, EMBEDDED_RELEASE_MARKER), 'utf-8') === 'r7')
  assert('the maps were read from the dist folder', !fs.existsSync(path.join(root, 'web', 'out', 'app-abc.js.map')))
  fs.rmSync(root, { recursive: true, force: true })
}

function testUploadSourcemapsFunctionsAliasAfterSpace() {
  console.log('\nTest: --functions after a space still works and warns once')
  const { root } = embedProject()
  const run = runCli(root, ['upload-sourcemaps', '--embed-sourcemaps', '--release', 'r1', '--functions', 'srv', '--dist', 'web/out'])
  assert('exit 0', run.status === 0, `${run.status} ${run.stderr.slice(0, 300)}`)
  assert('the map was embedded', fs.existsSync(path.join(root, 'srv', 'sourcemaps', 'current', 'app-abc.js.map')))
  assert('one deprecation warning', run.stderr.split('\n').filter((line) => line.includes('deprecated')).length === 1, run.stderr)
  fs.rmSync(root, { recursive: true, force: true })
}

function testUploadSourcemapsValueFlagWithNoValue() {
  console.log('\nTest: fsl upload-sourcemaps --bucket with no value exits 1 before any upload')
  const { root } = embedProject()
  for (const args of [['--bucket'], ['--bucket', '--embed-sourcemaps', '--backend', 'srv'], ['--embed-sourcemaps', '--backend']]) {
    const run = runCli(root, ['upload-sourcemaps', '--release', 'r1', '--dist', 'web/out', ...args])
    const flag = args.includes('--backend') && !args.includes('--bucket') ? '--backend' : '--bucket'
    assert(`${args.join(' ')}: exit 1`, run.status === 1, String(run.status))
    assert(`${args.join(' ')}: says ${flag} needs a value`, run.stderr.includes(`${flag} needs a value`), run.stderr)
    assert(`${args.join(' ')}: shows an upload-sourcemaps example`, run.stderr.includes('Example: fsl upload-sourcemaps'), run.stderr)
    assert(`${args.join(' ')}: the map is still in dist`, fs.existsSync(path.join(root, 'web', 'out', 'app-abc.js.map')))
  }
  fs.rmSync(root, { recursive: true, force: true })
}

function testInstallSkillsSwitchesKeepTheWord() {
  console.log('\nTest: install-skills --force and --global stay switches')
  const root = tempRoot()
  const first = runCli(root, ['install-skills', '--force'])
  assert('first install: exit 0', first.status === 0, `${first.status} ${first.stderr}`)
  assert('first install: skills installed in the project', fs.existsSync(path.join(root, '.claude', 'skills')))
  fs.appendFileSync(path.join(root, '.claude', 'skills', 'fsl-logs', 'SKILL.md'), '\nlocal edit\n')
  const unforced = runCli(root, ['install-skills'])
  assert('installing over existing skills without --force exits 1', unforced.status === 1, String(unforced.status))
  const forced = runCli(root, ['install-skills', '--force', 'stray'])
  assert('--force stray overwrites without asking: exit 0', forced.status === 0, `${forced.status} ${forced.stderr}`)

  const home = tempRoot()
  const out = spawnSync('npx', ['tsx', CLI, 'install-skills', '--global', 'stray', '--force'], {
    cwd: root,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert('--global stray: exit 0', out.status === 0, `${out.status} ${out.stderr}`)
  assert('--global stray: skills installed under the home folder', fs.existsSync(path.join(home, '.claude', 'skills')))
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
}

testEveryValueFlagInBothForms()
testValueFlagWithNoValueThrows()
testSwitchLeavesTheNextWord()
testDoctorSpaceFormEqualsEqualsForm()
testDoctorValueFlagWithNoValue()
testDoctorSwitchKeepsTheWord()
testDoctorStrictKeepsTheWord()
testUploadSourcemapsSpaceForm()
testUploadSourcemapsFunctionsAliasAfterSpace()
testUploadSourcemapsValueFlagWithNoValue()
testInstallSkillsSwitchesKeepTheWord()
reportResults()
