/**
 * `fsl doctor` — the findings and the setup summary, against fake projects.
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
import { runDoctor, exitCodeFor, checkUnsupportedPeers, formatDoctorReport, type DoctorReport, type DoctorFinding } from '../src/tools/doctor.js'
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

function mapsProject(): { root: string; dist: string } {
  const { root, dist } = firebaseProject()
  writeMap(dist, 'app-abc.js.map')
  return { root, dist }
}

function testMapsPublishedQuietWhenScriptUploads() {
  console.log('\nTest: maps-published stays quiet when a package.json script runs fsl upload-sourcemaps')
  const { root } = mapsProject()
  writeJson(path.join(root, 'package.json'), { scripts: { deploy: 'npm run build && fsl upload-sourcemaps && firebase deploy' } })
  assert('maps-published does not fire', !findingIds(runDoctor({ projectRoot: root })).includes('maps-published'))
  cleanup([root])
}

function testMapsPublishedQuietWhenPredeployUploads() {
  console.log('\nTest: maps-published stays quiet when hosting predeploy runs fsl upload-sourcemaps')
  const { root } = mapsProject()
  writeJson(path.join(root, 'firebase.json'), {
    functions: { source: 'functions' },
    hosting: { public: 'dist', predeploy: ['npm run build', 'fsl upload-sourcemaps'] },
  })
  assert('maps-published does not fire', !findingIds(runDoctor({ projectRoot: root })).includes('maps-published'))
  cleanup([root])
}

function testMapsPublishedQuietWhenHostingIgnoresMaps() {
  console.log('\nTest: maps-published stays quiet when hosting ignore excludes .map files')
  const { root } = mapsProject()
  writeJson(path.join(root, 'firebase.json'), {
    functions: { source: 'functions' },
    hosting: { public: 'dist', ignore: ['**/*.map'] },
  })
  assert('maps-published does not fire', !findingIds(runDoctor({ projectRoot: root })).includes('maps-published'))
  cleanup([root])
}

function testMapsPublishedFiresDespiteUnrelatedConfig() {
  console.log('\nTest: maps-published still fires when scripts and hosting config mention nothing about maps')
  const { root } = mapsProject()
  writeJson(path.join(root, 'package.json'), { scripts: { build: 'vite build' } })
  writeJson(path.join(root, 'firebase.json'), {
    functions: { source: 'functions' },
    hosting: { public: 'dist', predeploy: 'npm run build', ignore: ['firebase.json', '**/*.js.map'] },
  })
  assert('maps-published fires as an error', findingIds(runDoctor({ projectRoot: root })).includes('maps-published'))
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

// --- logs-inside-functions-source ---

function writeJsonl(dir: string, fileName: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), '{"severity":"INFO"}\n')
}

function testLogsInsideFunctionsSourceFires() {
  console.log('\nTest: logs-inside-functions-source fires when a .jsonl file sits under functions/ and ignore does not cover it')
  const { root, backend } = firebaseProject()
  writeJsonl(path.join(backend, 'logs'), 'dev.jsonl')
  const report = runDoctor({ projectRoot: root })
  assert('logs-inside-functions-source fires as a warning', findingIds(report).includes('logs-inside-functions-source'))
  assert('at warning level', report.findings.find((f) => f.id === 'logs-inside-functions-source')?.level === 'warning')
  const message = report.findings.find((f) => f.id === 'logs-inside-functions-source')?.message ?? ''
  assert('names the folder', message.includes('logs'), message)
  cleanup([root])
}

function testLogsInsideFunctionsSourceQuietWhenIgnored() {
  console.log('\nTest: logs-inside-functions-source stays quiet when firebase.json ignore covers the folder')
  const { root, backend } = firebaseProject()
  writeJson(path.join(root, 'firebase.json'), {
    functions: { source: 'functions', ignore: ['node_modules', '.git', 'logs'] },
    hosting: { public: 'dist' },
  })
  writeJsonl(path.join(backend, 'logs'), 'dev.jsonl')
  const report = runDoctor({ projectRoot: root })
  assert('logs-inside-functions-source does not fire', !findingIds(report).includes('logs-inside-functions-source'))
  cleanup([root])
}

function testLogsInsideFunctionsSourceQuietWithNoJsonl() {
  console.log('\nTest: logs-inside-functions-source stays quiet with no .jsonl files under functions/')
  const { root } = firebaseProject()
  const report = runDoctor({ projectRoot: root })
  assert('logs-inside-functions-source does not fire', !findingIds(report).includes('logs-inside-functions-source'))
  cleanup([root])
}

function testLogsInsideFunctionsSourceMultiCodebase() {
  console.log('\nTest: logs-inside-functions-source checks every codebase in a functions array')
  const root = tempProject()
  const api = path.join(root, 'api')
  const worker = path.join(root, 'worker')
  writeJson(path.join(root, 'firebase.json'), {
    functions: [
      { source: 'api', codebase: 'api' },
      { source: 'worker', codebase: 'worker', ignore: ['node_modules', '.git', 'logs'] },
    ],
  })
  writeJson(path.join(api, 'package.json'), { name: 'api', engines: { node: '>=22' } })
  writePackage(api, 'firebase-functions', '7.4.0')
  writeJson(path.join(worker, 'package.json'), { name: 'worker', engines: { node: '>=22' } })
  writePackage(worker, 'firebase-functions', '7.4.0')
  writeJsonl(path.join(api, 'logs'), 'dev.jsonl')
  writeJsonl(path.join(worker, 'logs'), 'dev.jsonl')

  const report = runDoctor({ projectRoot: root })
  const findings = report.findings.filter((f) => f.id === 'logs-inside-functions-source')
  assert('fires exactly once (api only — worker ignores logs)', findings.length === 1, JSON.stringify(findings))
  assert('names the api codebase folder', findings[0]?.message.includes('api'), JSON.stringify(findings))
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

// --- skill-out-of-date ---

const RUNNING_VERSION = (JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version: string }).version

function writeSkill(root: string, name: string, content: string): void {
  const dir = path.join(root, '.claude', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
}

function stamped(version: string): string {
  return `---\nname: x\ndescription: y\nfsl-version: ${version}\n---\n\n# x\n`
}

function testSkillOutOfDateFires() {
  console.log('\nTest: skill-out-of-date fires when a skill is stamped with a version other than the running fsl')
  const { root } = firebaseProject()
  writeSkill(root, 'fsl-review', stamped('0.0.1'))
  const report = runDoctor({ projectRoot: root })
  const finding = report.findings.find((f) => f.id === 'skill-out-of-date')
  assert('skill-out-of-date fires', finding !== undefined)
  assert('at warning level', finding?.level === 'warning')
  assert('names both versions', !!finding && finding.message.includes('0.0.1') && finding.message.includes(RUNNING_VERSION))
  assert('fix is install-skills', finding?.fix.includes('install-skills') === true && finding.fix.includes('--force') && !finding.fix.includes('npx') && !finding.fix.includes('<'), finding?.fix)
  cleanup([root])
}

function testStorageLineNamesTheLibraryAndNoBucket() {
  console.log('\nTest: the Storage line for firebase-admin names the library and no bucket')
  const { root, backend } = firebaseProject()
  writePackage(backend, 'firebase-admin', '14.5.0')
  const report = runDoctor({ projectRoot: root })
  assert('storage is firebase-admin', report.setup.storage === 'firebase-admin', report.setup.storage)
  const line = formatDoctorReport(report).split('\n').find((l) => l.trim().startsWith('Storage'))
  assert('the line names firebase-admin and no bucket', line !== undefined && line.includes('firebase-admin') && !/bucket/i.test(line), line)
  cleanup([root])
}

function testSkillOutOfDateQuietWhenEqual() {
  console.log('\nTest: skill-out-of-date stays quiet when the stamp equals the running fsl')
  const { root } = firebaseProject()
  writeSkill(root, 'fsl-review', stamped(RUNNING_VERSION))
  const report = runDoctor({ projectRoot: root })
  assert('no skill-out-of-date', !findingIds(report).includes('skill-out-of-date'))
  cleanup([root])
}

function testSkillWithoutStampIsNotOurs() {
  console.log('\nTest: a skill with no frontmatter, or no fsl-version, is skipped')
  const { root } = firebaseProject()
  writeSkill(root, 'plain', '# no frontmatter\n')
  writeSkill(root, 'unstamped', '---\nname: mine\ndescription: mine\n---\n')
  const report = runDoctor({ projectRoot: root })
  assert('no finding', findingIds(report).length === 0, findingIds(report).join(','))
  cleanup([root])
}

function testSkillCheckNeedsNothingInNodeModules() {
  console.log('\nTest: the check never needs fsl in the project\'s node_modules (web/ and functions/ layouts)')
  const { root } = firebaseProject()
  writeSkill(root, 'fsl-review', stamped(RUNNING_VERSION))
  const report = runDoctor({ projectRoot: root })
  assert('no could-not-check, no findings', findingIds(report).length === 0, findingIds(report).join(','))
  assert('the project has no fsl in node_modules', !fs.existsSync(path.join(root, 'node_modules', '@dasasian')))
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

// --- Finding the backend: flag, firebase.json key, search ---

const OWN_PACKAGE_NAME = (JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { name: string }).name

function writeAppPackageJson(dir: string, listedIn: 'dependencies' | 'devDependencies' | 'nowhere', extra: Record<string, unknown> = {}): void {
  const listing = listedIn === 'nowhere' ? {} : { [listedIn]: { [OWN_PACKAGE_NAME]: '^1.5.0' } }
  writeJson(path.join(dir, 'package.json'), { name: path.basename(dir), ...listing, ...extra })
}

function startsWithWords(text: string | undefined): boolean {
  return /^[A-Za-z]/.test(text ?? '')
}

function hostingOnlyProject(): string {
  const root = tempProject()
  writeJson(path.join(root, 'firebase.json'), {
    hosting: [{ target: 'app', public: 'frontend/dist' }, { target: 'admin', public: 'frontend/admin-dist' }],
    firestore: { rules: 'firestore.rules' },
  })
  writeAppPackageJson(path.join(root, 'backend'), 'dependencies')
  writeAppPackageJson(path.join(root, 'frontend'), 'devDependencies')
  fs.mkdirSync(path.join(root, 'frontend', 'dist'), { recursive: true })
  fs.mkdirSync(path.join(root, 'frontend', 'admin-dist'), { recursive: true })
  return root
}

function testSearchFindsTheBackendBesideAHostingOnlyFirebaseJson() {
  console.log('\nTest: Hosting-only firebase.json, no flags: the search finds ./backend')
  const root = hostingOnlyProject()
  const report = runDoctor({ projectRoot: root })
  assert('kind is node', report.setup.kind === 'node', report.setup.kind)
  assert('backend is ./backend', report.setup.backend === './backend', String(report.setup.backend))
  assert('backendFrom is search', report.setup.backendFrom === 'search', String(report.setup.backendFrom))
  assert('dist is the first hosting.public', report.setup.dist === './frontend/dist', String(report.setup.dist))
  assert('no findings at all', report.findings.length === 0, JSON.stringify(report.findings))
  assert('exit code 0', exitCodeFor(report, false) === 0)
  cleanup([root])
}

function testBackendFlagBesideAHostingOnlyFirebaseJson() {
  console.log('\nTest: Hosting-only firebase.json with --backend: same result, backendFrom is flag')
  const root = hostingOnlyProject()
  const report = runDoctor({ projectRoot: root, backend: './backend' })
  assert('kind is node', report.setup.kind === 'node', report.setup.kind)
  assert('backend is ./backend', report.setup.backend === './backend')
  assert('backendFrom is flag', report.setup.backendFrom === 'flag', String(report.setup.backendFrom))
  assert('no findings at all', report.findings.length === 0, JSON.stringify(report.findings))
  cleanup([root])
}

function testBackendFlagBeatsTheFunctionsKey() {
  console.log('\nTest: a functions key and a --backend naming another folder: the flag\'s folder is checked')
  const { root } = firebaseProject()
  writeJson(path.join(root, 'firebase.json'), { functions: { source: 'functions', runtime: 'nodejs18' }, hosting: { public: 'dist' } })
  writeAppPackageJson(path.join(root, 'server'), 'dependencies', { engines: { node: '18' } })
  const report = runDoctor({ projectRoot: root, backend: 'server' })
  const nodeVersion = report.findings.find((f) => f.id === 'node-version')
  assert('backend is ./server', report.setup.backend === './server', String(report.setup.backend))
  assert('backendFrom is flag', report.setup.backendFrom === 'flag')
  assert('kind is node, not firebase', report.setup.kind === 'node', report.setup.kind)
  assert('the flag folder\'s engines.node is judged', nodeVersion?.message.includes('server') === true, JSON.stringify(report.findings))
  assert('the key\'s runtime is not applied to it', !report.findings.some((f) => f.message.includes('nodejs18')), JSON.stringify(report.findings))
  assert('no callable-without-firebase-functions', !findingIds(report).includes('callable-without-firebase-functions'))
  cleanup([root])
}

function testFlagNamingTheFunctionsKeyFolderIsStillFirebase() {
  console.log('\nTest: --backend naming the folder the functions key names is kind firebase')
  const { root } = firebaseProject()
  const report = runDoctor({ projectRoot: root, backend: './functions/' })
  assert('kind is firebase', report.setup.kind === 'firebase', report.setup.kind)
  assert('backendFrom is flag', report.setup.backendFrom === 'flag')
  assert('callable is true', report.setup.callable === true)
  cleanup([root])
}

function testFunctionsKeyWithoutFlagsKeepsToday() {
  console.log('\nTest: a functions key and no flags: backendFrom is firebase.json, the rest as before')
  const { root } = firebaseProject()
  writeAppPackageJson(path.join(root, 'other'), 'dependencies')
  const report = runDoctor({ projectRoot: root })
  assert('backendFrom is firebase.json', report.setup.backendFrom === 'firebase.json', String(report.setup.backendFrom))
  assert('kind is firebase', report.setup.kind === 'firebase')
  assert('backend is ./functions even with another folder that lists the package', report.setup.backend === './functions')
  assert('no findings', report.findings.length === 0, JSON.stringify(report.findings))
  assert('Setup line is the one of today', formatDoctorReport(report).startsWith('Setup: Firebase — functions in ./functions, web build in ./dist\n'))
  cleanup([root])
}

function testFunctionsKeyWithoutSourceNamesFunctionsFolder() {
  console.log('\nTest: a functions key with no source means ./functions')
  const { root } = firebaseProject()
  writeJson(path.join(root, 'firebase.json'), { functions: {}, hosting: { public: 'dist' } })
  const report = runDoctor({ projectRoot: root })
  assert('backend is ./functions from firebase.json', report.setup.backend === './functions' && report.setup.backendFrom === 'firebase.json')
  cleanup([root])
}

function testCallableFindingNeedsTheFunctionsKey() {
  console.log('\nTest: callable-without-firebase-functions appears only with a functions key')
  const searched = hostingOnlyProject()
  assert('searched backend without firebase-functions: no callable finding', !findingIds(runDoctor({ projectRoot: searched })).includes('callable-without-firebase-functions'))
  const flagged = hostingOnlyProject()
  assert('flagged backend without firebase-functions: no callable finding', !findingIds(runDoctor({ projectRoot: flagged, backend: 'backend' })).includes('callable-without-firebase-functions'))
  const { root, backend } = firebaseProject()
  fs.rmSync(path.join(backend, 'node_modules', 'firebase-functions'), { recursive: true, force: true })
  const finding = runDoctor({ projectRoot: root }).findings.find((f) => f.id === 'callable-without-firebase-functions')
  assert('with the key it fires, and says the file configures functions', finding?.message.startsWith('firebase.json configures functions in ') === true)
  cleanup([searched, flagged, root])
}

function testSearchSkipsTheWebFolder() {
  console.log('\nTest: fsl in the web folder only, web build known: the backend is not checked')
  const root = hostingOnlyProject()
  fs.rmSync(path.join(root, 'backend'), { recursive: true, force: true })
  const report = runDoctor({ projectRoot: root })
  assert('backend is null', report.setup.backend === null)
  assert('backendFrom is null', report.setup.backendFrom === null)
  assert('kind is browser-only', report.setup.kind === 'browser-only', report.setup.kind)
  assert('no findings', report.findings.length === 0, JSON.stringify(report.findings))
  assert('exit code 0', exitCodeFor(report, false) === 0)
  assert('the Setup line says nothing about a missing backend', formatDoctorReport(report).startsWith('Setup: browser only — web build in ./frontend/dist\n'))
  cleanup([root])
}

function testTwoCandidatesAreCouldNotCheck() {
  console.log('\nTest: two candidates left: could-not-check names both, exit 1')
  const root = hostingOnlyProject()
  writeAppPackageJson(path.join(root, 'worker'), 'dependencies')
  const report = runDoctor({ projectRoot: root })
  const finding = report.findings.find((f) => f.id === 'could-not-check')
  assert('could-not-check fires as an error', finding?.level === 'error', JSON.stringify(report.findings))
  assert('names ./backend and ./worker', finding?.message.includes('./backend') === true && finding.message.includes('./worker'), finding?.message)
  assert('the fix names --backend', finding?.fix.includes('--backend=') === true, finding?.fix)
  assert('message and fix start with words, not a path', startsWithWords(finding?.message) && startsWithWords(finding?.fix), finding?.message)
  assert('backend is not checked', report.setup.backend === null && report.setup.backendFrom === null)
  assert('exit code 1', exitCodeFor(report, false) === 1)
  cleanup([root])
}

function testOneCandidateAndNoWebBuildIsCouldNotCheck() {
  console.log('\nTest: one candidate and no known web build: could-not-check names it and both flags, exit 1')
  const root = tempProject()
  writeAppPackageJson(path.join(root, 'backend'), 'dependencies')
  const report = runDoctor({ projectRoot: root })
  const finding = report.findings.find((f) => f.id === 'could-not-check')
  assert('could-not-check fires as an error', finding?.level === 'error', JSON.stringify(report.findings))
  assert('names ./backend', finding?.message.includes('./backend') === true, finding?.message)
  assert('the fix names --backend and --dist', finding?.fix.includes('--backend=') === true && finding.fix.includes('--dist='), finding?.fix)
  assert('the fix offers the flags as alternatives and names the candidate', finding?.fix.includes(' or ') === true && finding.fix.includes('./backend'), finding?.fix)
  assert('message and fix start with words, not a path', startsWithWords(finding?.message) && startsWithWords(finding?.fix), finding?.message)
  assert('backend is not taken', report.setup.backend === null)
  assert('exit code 1', exitCodeFor(report, false) === 1)
  cleanup([root])
}

function testRootCandidateMessageStartsWithWords() {
  console.log('\nTest: a candidate that is the project root does not make a message start with "."')
  const root = tempProject()
  writeAppPackageJson(root, 'dependencies')
  const finding = runDoctor({ projectRoot: root }).findings.find((f) => f.id === 'could-not-check')
  assert('could-not-check fires and names .', finding?.message.includes('(.)') === true, finding?.message)
  assert('message and fix start with words, not a path', startsWithWords(finding?.message) && startsWithWords(finding?.fix), finding?.message)
  cleanup([root])
}

function testEitherFlagAloneSettlesAnUnknownWebBuild() {
  console.log('\nTest: --dist alone, or --backend alone, is enough where the web build was unknown')
  const root = tempProject()
  writeAppPackageJson(path.join(root, 'backend'), 'dependencies')
  writeAppPackageJson(path.join(root, 'web'), 'dependencies')
  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true })
  assert('without a flag it is could-not-check', findingIds(runDoctor({ projectRoot: root })).includes('could-not-check'))
  const withDist = runDoctor({ projectRoot: root, dist: 'web/dist' })
  assert('--dist alone: backend is ./backend by search, no findings', withDist.setup.backend === './backend' && withDist.setup.backendFrom === 'search' && withDist.findings.length === 0, JSON.stringify(withDist))
  const withBackend = runDoctor({ projectRoot: root, backend: 'backend' })
  assert('--backend alone: backend is ./backend by flag, no findings', withBackend.setup.backend === './backend' && withBackend.setup.backendFrom === 'flag' && withBackend.findings.length === 0, JSON.stringify(withBackend))
  cleanup([root])
}

function testDistAloneSettlesTheOnlyCandidateBeingTheWebApp() {
  console.log('\nTest: one candidate that is the web app: --dist alone leaves no backend and no finding')
  const root = tempProject()
  writeAppPackageJson(path.join(root, 'web'), 'dependencies')
  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true })
  const report = runDoctor({ projectRoot: root, dist: 'web/dist' })
  assert('backend not checked, no findings', report.setup.backend === null && report.findings.length === 0, JSON.stringify(report))
  cleanup([root])
}

function testNoCandidateAtAllChecksNothingAndSaysNothing() {
  console.log('\nTest: nothing lists the package: no finding, no backend')
  const root = tempProject()
  writeAppPackageJson(path.join(root, 'backend'), 'nowhere')
  const report = runDoctor({ projectRoot: root })
  assert('no findings', report.findings.length === 0, JSON.stringify(report.findings))
  assert('backend is null', report.setup.backend === null && report.setup.backendFrom === null)
  cleanup([root])
}

function testSearchLooksOnlyWhereItSaysItLooks() {
  console.log('\nTest: the search ignores node_modules, dot folders and folders two levels down')
  const root = hostingOnlyProject()
  fs.rmSync(path.join(root, 'backend'), { recursive: true, force: true })
  writeAppPackageJson(path.join(root, 'node_modules'), 'dependencies')
  writeAppPackageJson(path.join(root, '.cache'), 'dependencies')
  writeAppPackageJson(path.join(root, 'services', 'api'), 'dependencies')
  const report = runDoctor({ projectRoot: root })
  assert('no candidate, so no backend and no finding', report.setup.backend === null && report.findings.length === 0, JSON.stringify(report))
  cleanup([root])
}

function testSearchRemovesAFolderHoldingTheWebBuild() {
  console.log('\nTest: a candidate that is, or contains, the web build folder is the web side')
  const root = hostingOnlyProject()
  writeAppPackageJson(root, 'dependencies')
  const report = runDoctor({ projectRoot: root })
  assert('the root holds the web build, so ./backend is the one left', report.setup.backend === './backend' && report.setup.backendFrom === 'search', JSON.stringify(report.setup))
  cleanup([root])
}

function testSearchWorksWithNoFirebaseJsonWhenDistIsGiven() {
  console.log('\nTest: no firebase.json, --dist given: the search still finds the backend')
  const root = tempProject()
  writeAppPackageJson(path.join(root, 'server'), 'dependencies')
  writeAppPackageJson(path.join(root, 'web'), 'dependencies')
  fs.mkdirSync(path.join(root, 'web', 'build'), { recursive: true })
  const report = runDoctor({ projectRoot: root, dist: 'web/build' })
  assert('backend is ./server from search', report.setup.backend === './server' && report.setup.backendFrom === 'search', JSON.stringify(report.setup))
  assert('kind is node', report.setup.kind === 'node')
  cleanup([root])
}

function testDistFlagBeatsHosting() {
  console.log('\nTest: --dist is the web build, and hosting.public is not added to it')
  const root = hostingOnlyProject()
  fs.mkdirSync(path.join(root, 'backend', 'public'), { recursive: true })
  const report = runDoctor({ projectRoot: root, dist: 'backend/public' })
  assert('dist is the flag\'s', report.setup.dist === './backend/public', String(report.setup.dist))
  assert('./backend now holds the web build, so ./frontend is the one left', report.setup.backend === './frontend' && report.setup.backendFrom === 'search', JSON.stringify(report.setup))
  cleanup([root])
}

function testUnreadablePackageJsonInTheSearchIsCouldNotCheck() {
  console.log('\nTest: a package.json the search cannot parse is could-not-check, never skipped')
  const root = hostingOnlyProject()
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tools', 'package.json'), '{ not json')
  const report = runDoctor({ projectRoot: root })
  const finding = report.findings.find((f) => f.id === 'could-not-check')
  assert('could-not-check fires', finding !== undefined, JSON.stringify(report.findings))
  assert('names ./tools', finding?.message.includes('./tools') === true, finding?.message)
  assert('message and fix start with words, not a path', startsWithWords(finding?.message) && startsWithWords(finding?.fix), finding?.message)
  assert('backend is not taken', report.setup.backend === null)
  assert('exit code 1', exitCodeFor(report, false) === 1)
  cleanup([root])
}

function testUnreadablePackageJsonOfTheWebFolderDoesNotMatter() {
  console.log('\nTest: a package.json that cannot be parsed in the web folder is not read')
  const root = hostingOnlyProject()
  fs.writeFileSync(path.join(root, 'frontend', 'package.json'), '{ not json')
  const report = runDoctor({ projectRoot: root })
  assert('backend is ./backend', report.setup.backend === './backend' && report.findings.length === 0, JSON.stringify(report))
  cleanup([root])
}

function testSetupLineMarksOnlyASearchedBackend() {
  console.log('\nTest: the Setup line marks a backend the search found, and no other')
  const searched = hostingOnlyProject()
  const flagged = hostingOnlyProject()
  assert('searched: marked', formatDoctorReport(runDoctor({ projectRoot: searched })).startsWith('Setup: Node — backend in ./backend (found by search), web build in ./frontend/dist\n'))
  assert('flagged: not marked', formatDoctorReport(runDoctor({ projectRoot: flagged, backend: 'backend' })).startsWith('Setup: Node — backend in ./backend, web build in ./frontend/dist\n'))
  cleanup([searched, flagged])
}

function testDuplicateStorageFixNamesYarn() {
  console.log('\nTest: the duplicate-storage fix says what a yarn user does')
  const { root, backend } = firebaseProject()
  writePackage(backend, '@google-cloud/storage', '8.2.0')
  writePackage(path.join(backend, 'node_modules', 'firebase-admin'), '@google-cloud/storage', '7.22.0')
  const fix = runDoctor({ projectRoot: root }).findings.find((f) => f.id === 'duplicate-storage')?.fix ?? ''
  assert('names npm dedupe', fix.includes('npm dedupe'), fix)
  assert('names the yarn 1 lockfile edit', fix.includes('yarn 1') && fix.includes('yarn.lock') && fix.includes('yarn install'), fix)
  cleanup([root])
}

function run() {
  testMapsPublishedFires()
  testMapsPublishedQuiet()
  testMapsPublishedQuietWhenScriptUploads()
  testMapsPublishedQuietWhenPredeployUploads()
  testMapsPublishedQuietWhenHostingIgnoresMaps()
  testMapsPublishedFiresDespiteUnrelatedConfig()
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
  testLogsInsideFunctionsSourceFires()
  testLogsInsideFunctionsSourceQuietWhenIgnored()
  testLogsInsideFunctionsSourceQuietWithNoJsonl()
  testLogsInsideFunctionsSourceMultiCodebase()
  testSkillOutOfDateFires()
  testStorageLineNamesTheLibraryAndNoBucket()
  testSkillOutOfDateQuietWhenEqual()
  testSkillWithoutStampIsNotOurs()
  testSkillCheckNeedsNothingInNodeModules()
  testFirebaseSetupSummary()
  testCloudRunSetupSummary()
  testSearchFindsTheBackendBesideAHostingOnlyFirebaseJson()
  testBackendFlagBesideAHostingOnlyFirebaseJson()
  testBackendFlagBeatsTheFunctionsKey()
  testFlagNamingTheFunctionsKeyFolderIsStillFirebase()
  testFunctionsKeyWithoutFlagsKeepsToday()
  testFunctionsKeyWithoutSourceNamesFunctionsFolder()
  testCallableFindingNeedsTheFunctionsKey()
  testSearchSkipsTheWebFolder()
  testTwoCandidatesAreCouldNotCheck()
  testOneCandidateAndNoWebBuildIsCouldNotCheck()
  testRootCandidateMessageStartsWithWords()
  testEitherFlagAloneSettlesAnUnknownWebBuild()
  testDistAloneSettlesTheOnlyCandidateBeingTheWebApp()
  testNoCandidateAtAllChecksNothingAndSaysNothing()
  testSearchLooksOnlyWhereItSaysItLooks()
  testSearchRemovesAFolderHoldingTheWebBuild()
  testSearchWorksWithNoFirebaseJsonWhenDistIsGiven()
  testDistFlagBeatsHosting()
  testUnreadablePackageJsonInTheSearchIsCouldNotCheck()
  testUnreadablePackageJsonOfTheWebFolderDoesNotMatter()
  testSetupLineMarksOnlyASearchedBackend()
  testDuplicateStorageFixNamesYarn()
  reportResults()
}

run()
