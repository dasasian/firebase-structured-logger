/**
 * `fsl doctor` — the 7 findings and the setup summary, against fake projects.
 *
 * Each fake project lives in its own temp directory, built fresh per test — never
 * `smoke/functions` or `smoke/cloudrun`, which need the maintainer's private setup
 * (see CLAUDE.md, "Tests run from a fresh clone"). Every finding gets a test where
 * it fires with its documented id and level, and one where the same setup, minus
 * the one thing that triggers it, stays quiet.
 *
 * Run: npx tsx tests/doctor.ts
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { runDoctor, exitCodeFor, checkUnsupportedPeers, type DoctorReport, type DoctorFinding } from '../src/tools/doctor.js'
import { RELEASE_MARKER } from '../src/shared/paths.js'
import { assert, reportResults } from './testHelpers.js'

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-doctor-'))
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

function writePackage(dir: string, name: string, version: string, extra: Record<string, unknown> = {}): void {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'))
  writeJson(path.join(pkgDir, 'package.json'), { name, version, ...extra })
}

function writeMap(dir: string, fileName: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }))
}

function findingIds(report: DoctorReport): string[] {
  return report.findings.map((f) => f.id)
}

function cleanup(dirs: string[]): void {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

// --- A minimal, healthy Firebase project: the base every finding test starts from ---

function firebaseProject(): { root: string; backend: string; dist: string } {
  const root = tempProject()
  const backend = path.join(root, 'functions')
  const dist = path.join(root, 'dist')
  writeJson(path.join(root, 'firebase.json'), {
    functions: { source: 'functions' },
    hosting: { public: 'dist' },
  })
  writeJson(path.join(backend, 'package.json'), { name: 'functions', engines: { node: '>=22' } })
  writePackage(backend, 'firebase-functions', '7.4.0')
  fs.mkdirSync(dist, { recursive: true })
  return { root, backend, dist }
}

// --- maps-published ---

function testMapsPublishedFires() {
  console.log('\nTest: maps-published fires when a .map file sits under the served dist')
  const { root, dist } = firebaseProject()
  writeMap(dist, 'app-abc.js.map')
  const report = runDoctor({ projectRoot: root })
  assert('maps-published fires as an error', findingIds(report).includes('maps-published'))
  assert('at error level', report.findings.find((f) => f.id === 'maps-published')?.level === 'error')
  cleanup([root])
}

function testMapsPublishedQuiet() {
  console.log('\nTest: maps-published stays quiet with no .map files under dist')
  const { root } = firebaseProject()
  const report = runDoctor({ projectRoot: root })
  assert('maps-published does not fire', !findingIds(report).includes('maps-published'))
  cleanup([root])
}

// --- node-version ---

function testNodeVersionFires() {
  console.log('\nTest: node-version fires when the backend engines.node is below 22')
  const { root, backend } = firebaseProject()
  writeJson(path.join(backend, 'package.json'), { name: 'functions', engines: { node: '18' } })
  const report = runDoctor({ projectRoot: root })
  assert('node-version fires as an error', findingIds(report).includes('node-version'))
  assert('at error level', report.findings.find((f) => f.id === 'node-version')?.level === 'error')
  cleanup([root])
}

function testNodeVersionQuiet() {
  console.log('\nTest: node-version stays quiet at 22 or above')
  const { root } = firebaseProject()
  const report = runDoctor({ projectRoot: root })
  assert('node-version does not fire', !findingIds(report).includes('node-version'))
  cleanup([root])
}

function testNodeVersionNotStatedIsNotAnError() {
  console.log('\nTest: node-version reports nothing when no source states a version')
  const { root, backend } = firebaseProject()
  writeJson(path.join(backend, 'package.json'), { name: 'functions' })
  const report = runDoctor({ projectRoot: root })
  assert('no node-version finding when unstated', !findingIds(report).includes('node-version'))
  cleanup([root])
}

// --- callable-without-firebase-functions ---

function testCallableWithoutFirebaseFunctionsFires() {
  console.log('\nTest: callable-without-firebase-functions fires when firebase-functions is not installed')
  const { root, backend } = firebaseProject()
  fs.rmSync(path.join(backend, 'node_modules', 'firebase-functions'), { recursive: true, force: true })
  const report = runDoctor({ projectRoot: root })
  assert('callable-without-firebase-functions fires as an error', findingIds(report).includes('callable-without-firebase-functions'))
  assert('at error level', report.findings.find((f) => f.id === 'callable-without-firebase-functions')?.level === 'error')
  assert('callable is reported false in the summary', report.setup.callable === false)
  cleanup([root])
}

function testCallableWithoutFirebaseFunctionsQuiet() {
  console.log('\nTest: callable-without-firebase-functions stays quiet when firebase-functions is installed')
  const { root } = firebaseProject()
  const report = runDoctor({ projectRoot: root })
  assert('callable-without-firebase-functions does not fire', !findingIds(report).includes('callable-without-firebase-functions'))
  assert('callable is reported true in the summary', report.setup.callable === true)
  cleanup([root])
}

// --- could-not-check ---

function testCouldNotCheckFires() {
  console.log('\nTest: could-not-check fires when firebase.json cannot be parsed')
  const root = tempProject()
  fs.writeFileSync(path.join(root, 'firebase.json'), '{ not json')
  const report = runDoctor({ projectRoot: root })
  assert('could-not-check fires as an error', findingIds(report).includes('could-not-check'))
  assert('at error level', report.findings.find((f) => f.id === 'could-not-check')?.level === 'error')
  assert('exit code is 1', exitCodeFor(report, false) === 1)
  cleanup([root])
}

function testCouldNotCheckQuiet() {
  console.log('\nTest: could-not-check stays quiet when firebase.json parses')
  const { root } = firebaseProject()
  const report = runDoctor({ projectRoot: root })
  assert('could-not-check does not fire', !findingIds(report).includes('could-not-check'))
  cleanup([root])
}

// --- duplicate-storage ---

function testDuplicateStorageFires() {
  console.log('\nTest: duplicate-storage fires when two copies of @google-cloud/storage are installed')
  const { root, backend } = firebaseProject()
  writePackage(backend, '@google-cloud/storage', '8.2.0')
  writePackage(path.join(backend, 'node_modules', 'firebase-admin'), '@google-cloud/storage', '7.22.0')
  const report = runDoctor({ projectRoot: root })
  assert('duplicate-storage fires as a warning', findingIds(report).includes('duplicate-storage'))
  assert('at warning level', report.findings.find((f) => f.id === 'duplicate-storage')?.level === 'warning')
  cleanup([root])
}

function testDuplicateStorageQuiet() {
  console.log('\nTest: duplicate-storage stays quiet with one copy of @google-cloud/storage')
  const { root, backend } = firebaseProject()
  writePackage(backend, '@google-cloud/storage', '8.2.0')
  const report = runDoctor({ projectRoot: root })
  assert('duplicate-storage does not fire', !findingIds(report).includes('duplicate-storage'))
  cleanup([root])
}

// --- unsupported-peer ---

function testUnsupportedPeerFires() {
  console.log('\nTest: unsupported-peer fires when an installed peer is below the supported range')
  const { root, backend } = firebaseProject()
  writePackage(backend, 'firebase-admin', '9.0.0')
  const report = runDoctor({ projectRoot: root })
  assert('unsupported-peer fires as a warning', findingIds(report).includes('unsupported-peer'))
  assert('at warning level', report.findings.find((f) => f.id === 'unsupported-peer')?.level === 'warning')
  cleanup([root])
}

function testUnsupportedPeerQuiet() {
  console.log('\nTest: unsupported-peer stays quiet when the installed peer is in range')
  const { root, backend } = firebaseProject()
  writePackage(backend, 'firebase-admin', '14.5.0')
  const report = runDoctor({ projectRoot: root })
  assert('unsupported-peer does not fire', !findingIds(report).includes('unsupported-peer'))
  cleanup([root])
}

function testUnreadablePeerRangeIsCouldNotCheck() {
  console.log('\nTest: a peer range doctor cannot evaluate is could-not-check, not a silent pass')
  const findings: DoctorFinding[] = []
  const { root, backend } = firebaseProject()
  writePackage(backend, 'firebase-admin', '9.0.0')
  checkUnsupportedPeers([backend], { 'firebase-admin': '^12.0.0 || ^13.0.0' }, findings)
  assert('could-not-check fires', findings.some((f) => f.id === 'could-not-check'), JSON.stringify(findings))
  assert('at error level', findings.find((f) => f.id === 'could-not-check')?.level === 'error')
  cleanup([root])
}

function testDuplicateStorageNamesWhoOwnsEachCopy() {
  console.log('\nTest: duplicate-storage says which package each copy belongs to')
  const { root, backend } = firebaseProject()
  writePackage(backend, '@google-cloud/storage', '8.2.0')
  writePackage(path.join(backend, 'node_modules', 'firebase-admin'), '@google-cloud/storage', '7.22.0')
  const report = runDoctor({ projectRoot: root })
  const message = report.findings.find((f) => f.id === 'duplicate-storage')?.message ?? ''
  assert('names the top-level copy', message.includes('8.2.0 at the top level'), message)
  assert('names the copy inside firebase-admin', message.includes('7.22.0 inside firebase-admin'), message)
  cleanup([root])
}

// --- embedded-maps-without-release ---

function testEmbeddedMapsWithoutReleaseFires() {
  console.log('\nTest: embedded-maps-without-release fires when maps are embedded with no marker')
  const { root, backend } = firebaseProject()
  writeMap(path.join(backend, 'sourcemaps', 'current'), 'app-abc.js.map')
  const report = runDoctor({ projectRoot: root })
  assert('embedded-maps-without-release fires as a warning', findingIds(report).includes('embedded-maps-without-release'))
  assert('at warning level', report.findings.find((f) => f.id === 'embedded-maps-without-release')?.level === 'warning')
  cleanup([root])
}

function testEmbeddedMapsWithoutReleaseQuiet() {
  console.log('\nTest: embedded-maps-without-release stays quiet when the marker is present')
  const { root, backend } = firebaseProject()
  const embedded = path.join(backend, 'sourcemaps', 'current')
  writeMap(embedded, 'app-abc.js.map')
  fs.writeFileSync(path.join(embedded, RELEASE_MARKER), 'r1')
  const report = runDoctor({ projectRoot: root })
  assert('embedded-maps-without-release does not fire', !findingIds(report).includes('embedded-maps-without-release'))
  cleanup([root])
}

// --- Setup summaries ---

function testFirebaseSetupSummary() {
  console.log('\nTest: a Firebase layout produces the documented summary')
  const { root } = firebaseProject()
  const report = runDoctor({ projectRoot: root })
  assert('kind is firebase', report.setup.kind === 'firebase')
  assert('backend is ./functions', report.setup.backend === './functions')
  assert('dist is ./dist', report.setup.dist === './dist')
  assert('logging is firebase-functions', report.setup.logging === 'firebase-functions')
  assert('trace is trigger', report.setup.trace === 'trigger')
  assert('callable is true', report.setup.callable === true)
  cleanup([root])
}

function testCloudRunSetupSummary() {
  console.log('\nTest: a Cloud Run layout produces the documented summary')
  const root = tempProject()
  const backend = path.join(root, 'server')
  const dist = path.join(root, 'build')
  writeJson(path.join(backend, 'package.json'), { name: 'server', engines: { node: '>=22' } })
  fs.mkdirSync(dist, { recursive: true })
  const report = runDoctor({ projectRoot: root, backend: 'server', dist: 'build' })
  assert('kind is node', report.setup.kind === 'node')
  assert('backend is ./server', report.setup.backend === './server')
  assert('dist is ./build', report.setup.dist === './build')
  assert('logging is stdout', report.setup.logging === 'stdout')
  assert('trace is header', report.setup.trace === 'header')
  assert('callable is false', report.setup.callable === false)
  cleanup([root])
}

function run() {
  testMapsPublishedFires()
  testMapsPublishedQuiet()
  testNodeVersionFires()
  testNodeVersionQuiet()
  testNodeVersionNotStatedIsNotAnError()
  testCallableWithoutFirebaseFunctionsFires()
  testCallableWithoutFirebaseFunctionsQuiet()
  testCouldNotCheckFires()
  testCouldNotCheckQuiet()
  testDuplicateStorageFires()
  testDuplicateStorageQuiet()
  testUnsupportedPeerFires()
  testUnsupportedPeerQuiet()
  testUnreadablePeerRangeIsCouldNotCheck()
  testDuplicateStorageNamesWhoOwnsEachCopy()
  testEmbeddedMapsWithoutReleaseFires()
  testEmbeddedMapsWithoutReleaseQuiet()
  testFirebaseSetupSummary()
  testCloudRunSetupSummary()
  reportResults()
}

run()
