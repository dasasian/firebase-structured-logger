/**
 * `fsl doctor`, run as a real process — exit codes and `--json`.
 *
 * `tests/doctor.ts` calls `runDoctor` directly; this drives the CLI itself
 * (`src/tools/index.ts` via `npx tsx`, so no build step is needed from a fresh
 * clone) to prove the exit code and `--json` output a script would actually see.
 *
 * Run: npx tsx tests/doctorProcess.ts
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { assert, reportResults } from './testHelpers.js'

const CLI = path.join(process.cwd(), 'src', 'tools', 'index.ts')

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-doctor-process-'))
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function writePackage(dir: string, name: string, version: string): void {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'))
  writeJson(path.join(pkgDir, 'package.json'), { name, version })
}

function cleanFirebaseProject(): { root: string; backend: string; dist: string } {
  const root = tempProject()
  const backend = path.join(root, 'functions')
  const dist = path.join(root, 'dist')
  writeJson(path.join(root, 'firebase.json'), { functions: { source: 'functions' }, hosting: { public: 'dist' } })
  writeJson(path.join(backend, 'package.json'), { name: 'functions', engines: { node: '>=22' } })
  writePackage(backend, 'firebase-functions', '7.4.0')
  fs.mkdirSync(dist, { recursive: true })
  return { root, backend, dist }
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const out = spawnSync('npx', ['tsx', CLI, 'doctor', ...args], { cwd, encoding: 'utf-8' })
  return { status: out.status, stdout: out.stdout, stderr: out.stderr }
}

function testCleanExitsZero() {
  console.log('\nTest: a clean setup exits 0')
  const { root } = cleanFirebaseProject()
  const out = runCli(root, [])
  assert('exit code is 0', out.status === 0, `status=${out.status} stderr=${out.stderr.slice(0, 300)}`)
  fs.rmSync(root, { recursive: true, force: true })
}

function testErrorExitsOne() {
  console.log('\nTest: an error exits 1')
  const root = tempProject()
  fs.writeFileSync(path.join(root, 'firebase.json'), '{ not json')
  const out = runCli(root, [])
  assert('exit code is 1', out.status === 1, `status=${out.status}`)
  fs.rmSync(root, { recursive: true, force: true })
}

function testWarningExitsZeroWithoutStrict() {
  console.log('\nTest: a warning alone exits 0 without --strict')
  const { root, backend } = cleanFirebaseProject()
  writePackage(backend, 'firebase-admin', '9.0.0')
  const out = runCli(root, [])
  assert('exit code is 0', out.status === 0, `status=${out.status}`)
  fs.rmSync(root, { recursive: true, force: true })
}

function testWarningExitsOneWithStrict() {
  console.log('\nTest: a warning exits 1 with --strict')
  const { root, backend } = cleanFirebaseProject()
  writePackage(backend, 'firebase-admin', '9.0.0')
  const out = runCli(root, ['--strict'])
  assert('exit code is 1', out.status === 1, `status=${out.status}`)
  fs.rmSync(root, { recursive: true, force: true })
}

function testCouldNotCheckAlwaysExitsOne() {
  console.log('\nTest: could-not-check exits 1 even without --strict')
  const root = tempProject()
  fs.writeFileSync(path.join(root, 'firebase.json'), '{ not json')
  const out = runCli(root, [])
  assert('exit code is 1', out.status === 1, `status=${out.status}`)
  fs.rmSync(root, { recursive: true, force: true })
}

function testJsonShape() {
  console.log('\nTest: --json matches the documented shape')
  const { root, backend } = cleanFirebaseProject()
  writePackage(backend, '@google-cloud/storage', '8.2.0')
  writePackage(path.join(backend, 'node_modules', 'firebase-admin'), '@google-cloud/storage', '7.22.0')
  const out = runCli(root, ['--json'])
  assert('exit code is 0 (duplicate-storage is a warning)', out.status === 0, `status=${out.status} stderr=${out.stderr.slice(0, 300)}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(out.stdout.trim())
  } catch {
    parsed = undefined
  }
  assert('stdout is valid JSON', parsed !== undefined, out.stdout.slice(0, 300))
  if (parsed === undefined) {
    fs.rmSync(root, { recursive: true, force: true })
    return
  }
  const report = parsed as Record<string, unknown>
  assert('has a setup object', typeof report.setup === 'object' && report.setup !== null)
  assert('has a findings array', Array.isArray(report.findings))
  assert('has a numeric exitCode', typeof report.exitCode === 'number')

  const setup = report.setup as Record<string, unknown>
  for (const field of ['kind', 'backend', 'backendFrom', 'dist', 'logging', 'trace', 'storage', 'callable']) {
    assert(`setup has "${field}"`, field in setup, JSON.stringify(setup))
  }

  const findings = report.findings as Array<Record<string, unknown>>
  const duplicate = findings.find((f) => f.id === 'duplicate-storage')
  assert('duplicate-storage is present', duplicate !== undefined, JSON.stringify(findings))
  if (duplicate) {
    assert('has id, level, message, fix', 'id' in duplicate && 'level' in duplicate && 'message' in duplicate && 'fix' in duplicate)
    assert('level is warning', duplicate.level === 'warning')
  }
  fs.rmSync(root, { recursive: true, force: true })
}

function testJsonCarriesLogsInsideFunctionsSource() {
  console.log('\nTest: --json carries logs-inside-functions-source when a .jsonl file sits under functions/')
  const { root, backend } = cleanFirebaseProject()
  fs.mkdirSync(path.join(backend, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(backend, 'logs', 'dev.jsonl'), '{"severity":"INFO"}\n')
  const out = runCli(root, ['--json'])

  let parsed: unknown
  try {
    parsed = JSON.parse(out.stdout.trim())
  } catch {
    parsed = undefined
  }
  assert('stdout is valid JSON', parsed !== undefined, out.stdout.slice(0, 300))
  if (parsed === undefined) {
    fs.rmSync(root, { recursive: true, force: true })
    return
  }
  const findings = (parsed as Record<string, unknown>).findings as Array<Record<string, unknown>>
  const finding = findings.find((f) => f.id === 'logs-inside-functions-source')
  assert('logs-inside-functions-source is present', finding !== undefined, JSON.stringify(findings))
  assert('at warning level', finding?.level === 'warning', JSON.stringify(finding))
  fs.rmSync(root, { recursive: true, force: true })
}

function testJsonCarriesSkillOutOfDate() {
  console.log('\nTest: --json carries skill-out-of-date for a stale skill')
  const { root } = cleanFirebaseProject()
  const skillDir = path.join(root, '.claude', 'skills', 'fsl-review')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: fsl-review\ndescription: x\nfsl-version: 0.0.1\n---\n')
  const out = runCli(root, ['--json'])
  const findings = (JSON.parse(out.stdout.trim()) as { findings: Array<Record<string, unknown>> }).findings
  const finding = findings.find((f) => f.id === 'skill-out-of-date')
  assert('skill-out-of-date is present', finding !== undefined, JSON.stringify(findings))
  assert('at warning level, with the install-skills fix', finding?.level === 'warning' && typeof finding?.fix === 'string' && finding.fix.includes('node_modules/.bin/fsl install-skills') && !finding.fix.includes('npx'), JSON.stringify(finding))
  fs.rmSync(root, { recursive: true, force: true })
}

function hostingOnlySplitProject(): string {
  const root = tempProject()
  writeJson(path.join(root, 'firebase.json'), { hosting: [{ public: 'frontend/dist' }, { public: 'frontend/admin-dist' }], firestore: {} })
  for (const folder of ['backend', 'frontend']) {
    writeJson(path.join(root, folder, 'package.json'), { name: folder, dependencies: { '@dasasian/firebase-structured-logger': '^1.5.0' } })
  }
  fs.mkdirSync(path.join(root, 'frontend', 'dist'), { recursive: true })
  return root
}

function testSearchFindsBackendFromTheRootWithNoFlags() {
  console.log('\nTest: Hosting + Cloud Run layout, no flags: backend from the search, exit 0, in --json and in the report')
  const root = hostingOnlySplitProject()
  const json = runCli(root, ['--json'])
  const parsed = JSON.parse(json.stdout.trim()) as { setup: Record<string, unknown>; findings: unknown[] }
  assert('exit code is 0', json.status === 0, `status=${json.status} ${json.stdout.slice(0, 300)}`)
  assert('setup.backendFrom is "search"', parsed.setup.backendFrom === 'search', JSON.stringify(parsed.setup))
  assert('setup.kind is node and backend ./backend', parsed.setup.kind === 'node' && parsed.setup.backend === './backend')
  assert('no findings', parsed.findings.length === 0, JSON.stringify(parsed.findings))
  const human = runCli(root, [])
  assert('the printed Setup line marks the search', human.stdout.startsWith('Setup: Node — backend in ./backend (found by search), web build in ./frontend/dist'), human.stdout.slice(0, 200))
  const flagged = JSON.parse(runCli(root, ['--json', '--backend=./backend']).stdout.trim()) as { setup: Record<string, unknown> }
  assert('with --backend the field is "flag"', flagged.setup.backendFrom === 'flag', JSON.stringify(flagged.setup))
  fs.rmSync(root, { recursive: true, force: true })
}

function testFunctionsKeyReportsFirebaseJson() {
  console.log('\nTest: a functions key and no flags: --json carries backendFrom "firebase.json"')
  const { root } = cleanFirebaseProject()
  const parsed = JSON.parse(runCli(root, ['--json']).stdout.trim()) as { setup: Record<string, unknown> }
  assert('setup.backendFrom is "firebase.json"', parsed.setup.backendFrom === 'firebase.json', JSON.stringify(parsed.setup))
  fs.rmSync(root, { recursive: true, force: true })
}

function testAmbiguousSearchExitsOne() {
  console.log('\nTest: two backend candidates exit 1 and name both')
  const root = hostingOnlySplitProject()
  writeJson(path.join(root, 'worker', 'package.json'), { name: 'worker', dependencies: { '@dasasian/firebase-structured-logger': '^1.5.0' } })
  const out = runCli(root, [])
  assert('exit code is 1', out.status === 1, `status=${out.status}`)
  assert('names both folders', out.stdout.includes('./backend') && out.stdout.includes('./worker'), out.stdout.slice(0, 400))
  fs.rmSync(root, { recursive: true, force: true })
}

function run() {
  testCleanExitsZero()
  testJsonCarriesSkillOutOfDate()
  testErrorExitsOne()
  testWarningExitsZeroWithoutStrict()
  testWarningExitsOneWithStrict()
  testCouldNotCheckAlwaysExitsOne()
  testJsonShape()
  testJsonCarriesLogsInsideFunctionsSource()
  testSearchFindsBackendFromTheRootWithNoFlags()
  testFunctionsKeyReportsFirebaseJson()
  testAmbiguousSearchExitsOne()
  reportResults()
}

run()
