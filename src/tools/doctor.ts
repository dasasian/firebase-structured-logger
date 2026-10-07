/**
 * `fsl doctor` — checks a project's setup from disk and reports how it will behave.
 *
 * Every fact comes from a file with a fixed format: `firebase.json`, `package.json`,
 * each installed package's own `package.json`, `dist/`, and the embedded `.release`
 * marker. Nothing
 * here parses source code or guesses at behavior — a check that cannot read what it
 * needs reports `could-not-check`, never a pass (see CLAUDE.md, "fsl doctor — facts,
 * not guesses"). The finding ids, levels, and the `--json` shape are the README's
 * "Check your setup" section, verbatim; this file exists to make that section true.
 */

import * as fs from 'fs'
import * as path from 'path'
import { minimatch } from 'minimatch'
import { RELEASE_MARKER, embeddedDir, embeddedMarkerPath } from '../shared/paths.js'
import { findPackageCopies, findTopLevelVersion, readPackageJson } from '../shared/nodeModules.js'
import { leadingMajorVersion, meetsMinimum } from '../shared/versionRange.js'

export type SetupKind = 'firebase' | 'node' | 'browser-only' | 'backend-only'
export type LoggingPath = 'firebase-functions' | 'stdout' | 'none'
export type TraceSource = 'trigger' | 'header' | 'none'
export type StoragePath = 'firebase-admin' | 'google-cloud-storage' | 'none'
export type FindingLevel = 'error' | 'warning'

export type FindingId =
  | 'maps-published'
  | 'node-version'
  | 'callable-without-firebase-functions'
  | 'could-not-check'
  | 'duplicate-storage'
  | 'unsupported-peer'
  | 'embedded-maps-without-release'
  | 'logs-inside-functions-source'

export interface DoctorSetup {
  kind: SetupKind
  backend: string | null
  dist: string | null
  logging: LoggingPath
  trace: TraceSource
  storage: StoragePath
  callable: boolean
}

export interface DoctorFinding {
  id: FindingId
  level: FindingLevel
  message: string
  fix: string
}

export interface DoctorReport {
  setup: DoctorSetup
  findings: DoctorFinding[]
  exitCode: number
}

export interface DoctorOptions {
  projectRoot: string
  backend?: string
  dist?: string
}

interface FirebaseFunctionsConfig {
  source?: string
  runtime?: string
  ignore?: string[]
}

interface FirebaseHostingConfig {
  public?: string
}

interface FirebaseJson {
  functions?: FirebaseFunctionsConfig | FirebaseFunctionsConfig[]
  hosting?: FirebaseHostingConfig | FirebaseHostingConfig[]
}

const PEER_PACKAGES = ['firebase', 'firebase-admin', 'firebase-functions'] as const

function readFirebaseJson(projectRoot: string): { ok: true; config: FirebaseJson } | { ok: false; finding: DoctorFinding } | { ok: 'absent' } {
  const file = path.join(projectRoot, 'firebase.json')
  if (!fs.existsSync(file)) return { ok: 'absent' }
  try {
    return { ok: true, config: JSON.parse(fs.readFileSync(file, 'utf-8')) as FirebaseJson }
  } catch {
    return {
      ok: false,
      finding: couldNotCheck('firebase.json could not be parsed as JSON.', 'Fix the syntax error in firebase.json.'),
    }
  }
}

function couldNotCheck(message: string, fix: string): DoctorFinding {
  return { id: 'could-not-check', level: 'error', message, fix }
}

function firstOf<T>(value: T | T[] | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** `firebase.json` -> `functions` is one codebase's config, or an array of several. */
function allOf<T>(value: T | T[] | undefined): T[] {
  return Array.isArray(value) ? value : value ? [value] : []
}

function hostingPublicDirs(hosting: FirebaseHostingConfig | FirebaseHostingConfig[] | undefined): string[] {
  const configs = Array.isArray(hosting) ? hosting : hosting ? [hosting] : []
  return configs.map((c) => c.public).filter((p): p is string => typeof p === 'string')
}

/**
 * Determine the setup this project has, from `firebase.json` when present, or from
 * `--backend`/`--dist` otherwise. `dist` here is "the folder hosting serves" — under
 * Firebase that is `hosting.public`; outside Firebase it is whatever `--dist` names.
 */
function detectSetup(options: DoctorOptions, findings: DoctorFinding[]): { kind: SetupKind; backendDir: string | null; distDirs: string[] } {
  const firebaseJson = readFirebaseJson(options.projectRoot)

  if (firebaseJson.ok === false) {
    findings.push(firebaseJson.finding)
    return { kind: 'firebase', backendDir: null, distDirs: [] }
  }

  if (firebaseJson.ok === true) {
    const functionsConfig = firstOf(firebaseJson.config.functions)
    const backend = functionsConfig?.source ?? 'functions'
    const distDirs = hostingPublicDirs(firebaseJson.config.hosting)
    return {
      kind: 'firebase',
      backendDir: path.resolve(options.projectRoot, backend),
      distDirs: distDirs.map((d) => path.resolve(options.projectRoot, d)),
    }
  }

  const backendDir = options.backend ? path.resolve(options.projectRoot, options.backend) : null
  const distDirs = options.dist ? [path.resolve(options.projectRoot, options.dist)] : []
  const kind: SetupKind = backendDir && distDirs.length ? 'node' : backendDir ? 'backend-only' : distDirs.length ? 'browser-only' : 'backend-only'
  return { kind, backendDir, distDirs }
}

function findMapFiles(dir: string): string[] {
  const results: string[] = []
  if (!fs.existsSync(dir)) return results
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.map')) results.push(full)
    }
  }
  walk(dir)
  return results
}

function checkMapsPublished(distDirs: string[], findings: DoctorFinding[]): void {
  for (const dist of distDirs) {
    const maps = findMapFiles(dist)
    if (maps.length === 0) continue
    findings.push({
      id: 'maps-published',
      level: 'error',
      message: `${maps.length} .map file(s) found under ${dist}, which hosting serves — your source code is public.`,
      fix: `Run fsl upload-sourcemaps before deploying, so maps leave ${dist} instead of being published.`,
    })
    return
  }
}

function checkNodeVersion(
  backendDir: string | null,
  firebaseRuntime: string | undefined,
  findings: DoctorFinding[],
): void {
  if (!backendDir) return

  if (firebaseRuntime) {
    const major = leadingMajorVersion(firebaseRuntime)
    if (major !== undefined && major < 22) {
      findings.push({
        id: 'node-version',
        level: 'error',
        message: `firebase.json sets the functions runtime to ${firebaseRuntime}, below the supported floor of Node 22.`,
        fix: 'Set functions.runtime to "nodejs22" (or later) in firebase.json.',
      })
      return
    }
    if (major !== undefined) return
  }

  const read = readPackageJson(backendDir)
  if (!read.ok) {
    if (read.reason === 'missing') {
      findings.push(couldNotCheck(`No package.json in ${backendDir}. Run npm install first.`, 'Run npm install in the backend directory.'))
    } else {
      findings.push(couldNotCheck(`${path.join(backendDir, 'package.json')} could not be parsed as JSON.`, 'Fix the syntax error in the backend package.json.'))
    }
    return
  }

  const engines = read.pkg.engines as { node?: string } | undefined
  const engineNode = engines?.node
  if (!engineNode) return

  const major = leadingMajorVersion(engineNode)
  if (major !== undefined && major < 22) {
    findings.push({
      id: 'node-version',
      level: 'error',
      message: `${path.join(backendDir, 'package.json')} sets engines.node to "${engineNode}", below the supported floor of Node 22.`,
      fix: 'Set engines.node to ">=22" in the backend package.json.',
    })
  }
}

function checkCallable(kind: SetupKind, backendDir: string | null, findings: DoctorFinding[]): boolean {
  if (kind !== 'firebase' || !backendDir) return false
  const version = findTopLevelVersion([backendDir], 'firebase-functions')
  if (version) return true
  findings.push({
    id: 'callable-without-firebase-functions',
    level: 'error',
    message: `firebase.json configures functions in ${backendDir}, but firebase-functions is not installed there.`,
    fix: `Run npm install firebase-functions in ${backendDir}.`,
  })
  return false
}

function checkDuplicateStorage(backendDir: string | null, findings: DoctorFinding[]): void {
  if (!backendDir || !fs.existsSync(path.join(backendDir, 'node_modules'))) return
  const copies = findPackageCopies(backendDir, '@google-cloud/storage')
  const versions = [...new Set(copies.map((c) => c.version))]
  if (versions.length <= 1) return
  const placed = copies.map((c) => `${c.version} ${describeOwner(ownerOf(c.dir))}`)
  findings.push({
    id: 'duplicate-storage',
    level: 'warning',
    message: `${copies.length} copies of @google-cloud/storage (${placed.join(', ')})`,
    fix: 'npm dedupe',
  })
}

function displayPath(projectRoot: string, dir: string): string {
  const relative = path.relative(projectRoot, dir)
  if (relative === '') return '.'
  return relative.startsWith('..') || path.isAbsolute(relative) ? relative : `./${relative}`
}

function ownerOf(packageDir: string): string | null {
  const parts = packageDir.split(path.sep)
  const nodeModules = parts.lastIndexOf('node_modules')
  const previous = parts.lastIndexOf('node_modules', nodeModules - 1)
  if (previous === -1) return null
  const owner = parts.slice(previous + 1, nodeModules)
  return owner.join('/')
}

function describeOwner(owner: string | null): string {
  return owner === null ? 'at the top level' : `inside ${owner}`
}

/**
 * A peer whose supported range cannot be evaluated is `could-not-check`, never a pass:
 * the ranges are read from this package's own `peerDependencies`, and a range shape
 * `meetsMinimum` does not understand must surface rather than skip the check.
 */
export function checkUnsupportedPeers(
  searchDirs: string[],
  ownPeerDependencies: Record<string, string>,
  findings: DoctorFinding[],
): void {
  for (const peer of PEER_PACKAGES) {
    const range = ownPeerDependencies[peer]
    if (!range) continue
    const installed = findTopLevelVersion(searchDirs, peer)
    if (!installed) continue
    const meets = meetsMinimum(installed, range)
    if (meets === undefined) {
      findings.push({
        id: 'could-not-check',
        level: 'error',
        message: `Could not compare ${peer} ${installed} with the supported range ${range}.`,
        fix: 'Report this at https://github.com/dasasian/firebase-structured-logger/issues — doctor needs to learn this range shape.',
      })
    } else if (meets === false) {
      findings.push({
        id: 'unsupported-peer',
        level: 'warning',
        message: `${peer} ${installed} is installed, outside this package's supported range (${range}).`,
        fix: `Upgrade ${peer} to satisfy ${range}.`,
      })
    }
  }
}

const LOGS_WALK_MAX_DEPTH = 8
const LOGS_WALK_MAX_ENTRIES = 5000

/**
 * Finds `*.jsonl` files under `dir`, skipping `node_modules`, symlinks, and anything
 * `isIgnored` matches — checked, and pruned without descending, at every directory
 * along the way, the same order firebase-tools applies `ignore` in its own recursive
 * walk (see `isIgnoredByFirebaseTools`): a file inside an ignored directory is never
 * visited, rather than visited and then filtered out by its own name. Depth and total
 * entries visited are capped — a real Functions source tree fits comfortably under
 * both, and the caps keep this cheap on one that does not (a stray symlink loop, a
 * vendored dependency tree someone forgot to call `node_modules`).
 */
function findJsonlFiles(dir: string, isIgnored: (fullPath: string) => boolean): string[] {
  const results: string[] = []
  let visited = 0
  const walk = (current: string, depth: number) => {
    if (depth > LOGS_WALK_MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= LOGS_WALK_MAX_ENTRIES) return
      visited++
      if (entry.isSymbolicLink()) continue
      const full = path.join(current, entry.name)
      if (isIgnored(full)) continue
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full)
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir, 0)
  return results
}

/** Always appended by firebase-tools regardless of a custom `ignore` list. */
const FIREBASE_TOOLS_ALWAYS_IGNORED = ['firebase-debug.log', 'firebase-debug.*.log', '.runtimeconfig.json']
/** firebase-tools' default `functions.ignore`, used only when `ignore` is absent. */
const FIREBASE_TOOLS_DEFAULT_IGNORE = ['node_modules', '.git']

/**
 * Mirrors how firebase-tools decides whether a file in a Functions source folder is
 * ignored (same semantics for the emulator's watcher and for `deploy`'s upload):
 * `minimatch(fullPath, pattern, { matchBase: true, dot: true })` against each pattern
 * in `functions.ignore`, or `FIREBASE_TOOLS_DEFAULT_IGNORE` when `ignore` is absent —
 * either way with `FIREBASE_TOOLS_ALWAYS_IGNORED` appended. Source: firebase-tools'
 * `packageSource` in `src/deploy/functions/prepareFunctionsUpload.ts` (the ignore list
 * and its defaults) and `readdirRecursive` in `src/fsAsync.ts` (the minimatch call and
 * its options).
 */
function isIgnoredByFirebaseTools(filePath: string, configuredIgnore: string[] | undefined): boolean {
  const patterns = [...(configuredIgnore ?? FIREBASE_TOOLS_DEFAULT_IGNORE), ...FIREBASE_TOOLS_ALWAYS_IGNORED]
  return patterns.some((pattern) => minimatch(filePath, pattern, { matchBase: true, dot: true }))
}

function checkLogsInsideFunctionsSource(
  projectRoot: string,
  functionsConfigs: FirebaseFunctionsConfig[],
  findings: DoctorFinding[],
): void {
  for (const config of functionsConfigs) {
    const sourceDir = path.resolve(projectRoot, config.source ?? 'functions')
    const flagged = findJsonlFiles(sourceDir, (p) => isIgnoredByFirebaseTools(p, config.ignore))
    if (flagged.length === 0) continue

    const folders = [...new Set(flagged.map((f) => displayPath(projectRoot, path.dirname(f))))]
    findings.push({
      id: 'logs-inside-functions-source',
      level: 'warning',
      message: `${flagged.length} .jsonl file(s) under ${displayPath(projectRoot, sourceDir)}, not excluded by ignore: ${folders.join(', ')}`,
      fix: "Point logLocalDir outside the Functions source, e.g. logLocalDir: '../.fsl-logs'.",
    })
  }
}

function checkEmbeddedMapsWithoutRelease(backendDir: string | null, findings: DoctorFinding[]): void {
  if (!backendDir) return
  const dir = embeddedDir(backendDir)
  if (!fs.existsSync(dir)) return
  const hasMaps = fs.readdirSync(dir).some((f) => f.endsWith('.map'))
  if (!hasMaps) return
  if (fs.existsSync(embeddedMarkerPath(backendDir))) return
  findings.push({
    id: 'embedded-maps-without-release',
    level: 'warning',
    message: `${dir} has embedded maps but no ${RELEASE_MARKER} marker — an older release's stack can resolve against the wrong map.`,
    fix: 'Re-run fsl upload-sourcemaps --embed-sourcemaps, which writes the marker.',
  })
}

/** This package's own `package.json`, read at runtime — never copied into doctor. */
function readOwnPackageJson(): Record<string, unknown> {
  const read = readPackageJson(path.join(__dirname, '..', '..'))
  if (!read.ok) throw new Error('fsl doctor could not read its own package.json')
  return read.pkg
}

function resolveStorage(searchDirs: string[]): StoragePath {
  if (findTopLevelVersion(searchDirs, 'firebase-admin')) return 'firebase-admin'
  if (findTopLevelVersion(searchDirs, '@google-cloud/storage')) return 'google-cloud-storage'
  return 'none'
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const findings: DoctorFinding[] = []
  const { kind, backendDir, distDirs } = detectSetup(options, findings)

  const firebaseJson = readFirebaseJson(options.projectRoot)
  const firebaseRuntime = firebaseJson.ok === true ? firstOf(firebaseJson.config.functions)?.runtime : undefined

  checkMapsPublished(distDirs, findings)
  checkNodeVersion(backendDir, firebaseRuntime, findings)
  const callable = checkCallable(kind, backendDir, findings)
  checkDuplicateStorage(backendDir, findings)

  const searchDirs = [backendDir, options.projectRoot].filter((d): d is string => d !== null)
  const ownPkg = readOwnPackageJson()
  checkUnsupportedPeers(searchDirs, (ownPkg.peerDependencies as Record<string, string>) ?? {}, findings)
  if (firebaseJson.ok === true) {
    checkLogsInsideFunctionsSource(options.projectRoot, allOf(firebaseJson.config.functions), findings)
  }
  checkEmbeddedMapsWithoutRelease(backendDir, findings)

  const hasFirebaseFunctions = backendDir !== null && findTopLevelVersion([backendDir], 'firebase-functions') !== undefined
  const logging: LoggingPath = kind === 'firebase' && hasFirebaseFunctions ? 'firebase-functions' : backendDir ? 'stdout' : 'none'
  const trace: TraceSource = kind === 'firebase' && hasFirebaseFunctions ? 'trigger' : backendDir ? 'header' : 'none'
  const storage = resolveStorage(searchDirs)

  const setup: DoctorSetup = {
    kind,
    backend: backendDir ? displayPath(options.projectRoot, backendDir) : null,
    dist: distDirs[0] ? displayPath(options.projectRoot, distDirs[0]) : null,
    logging,
    trace,
    storage,
    callable,
  }

  const hasError = findings.some((f) => f.level === 'error')
  const exitCode = hasError ? 1 : 0

  return { setup, findings, exitCode }
}

/** `report.exitCode` ignores `--strict`; the CLI applies it here. */
export function exitCodeFor(report: DoctorReport, strict: boolean): number {
  if (report.findings.some((f) => f.level === 'error')) return 1
  if (strict && report.findings.some((f) => f.level === 'warning')) return 1
  return 0
}

const SETUP_LABEL: Record<SetupKind, string> = {
  firebase: 'Firebase',
  node: 'Node',
  'browser-only': 'browser only',
  'backend-only': 'backend only',
}

const LOGGING_LABEL: Record<LoggingPath, string> = {
  'firebase-functions': 'firebase-functions write()',
  stdout: 'stdout JSON (createHttpLogHandler)',
  none: 'not applicable — no backend given',
}

const TRACE_LABEL: Record<TraceSource, string> = {
  trigger: 'from each Cloud Functions trigger',
  header: 'from the x-cloud-trace-context header',
  none: 'not applicable — no backend given',
}

const STORAGE_LABEL: Record<StoragePath, string> = {
  'firebase-admin': 'firebase-admin, default bucket',
  'google-cloud-storage': '@google-cloud/storage — needs a bucket named in code (not checked)',
  none: 'not configured',
}

/** Renders the human-readable report `fsl doctor` prints without `--json`. */
export function formatDoctorReport(report: DoctorReport): string {
  const { setup, findings } = report
  const backendNoun = setup.kind === 'firebase' ? 'functions' : 'backend'
  const location = setup.backend && setup.dist
    ? `${backendNoun} in ${setup.backend}, web build in ${setup.dist}`
    : setup.backend
      ? `backend in ${setup.backend}`
      : setup.dist
        ? `web build in ${setup.dist}`
        : 'nothing to check — pass --backend and/or --dist'

  const lines = [
    `Setup: ${SETUP_LABEL[setup.kind]} — ${location}`,
    '',
    pad('Logging', LOGGING_LABEL[setup.logging]),
    pad('Trace ids', TRACE_LABEL[setup.trace]),
    pad('Storage', STORAGE_LABEL[setup.storage]),
    pad('Callable', setup.callable ? 'createClientLogFunction available' : 'not available'),
  ]

  if (findings.length > 0) {
    lines.push('')
    for (const finding of findings) {
      const icon = finding.level === 'error' ? '✗' : '⚠'
      const indent = ' '.repeat(4)
      lines.push(`  ${icon} ${finding.id.padEnd(20)} ${finding.message}`)
      lines.push(`${indent}${' '.repeat(20)}Fix: ${finding.fix}`)
    }
  }

  return lines.join('\n')
}

function pad(label: string, value: string): string {
  return `  ${label.padEnd(15)}${value}`
}
