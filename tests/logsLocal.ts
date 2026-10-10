/**
 * `fsl logs --local` against files the functions logger's emulator branch really wrote,
 * and the CLI wiring as a process. Needs FUNCTIONS_EMULATOR=true (set in the `test` script):
 * the logger reads it at module load.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/logsLocal.ts
 */

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { initLogger, writeLog } from '../src/functions/logger.js'
import { assert, reportResults } from './testHelpers.js'
import { runFsl, tempProject } from './logsHelpers.js'

const CLI = path.join(process.cwd(), 'src', 'tools', 'index.ts')

function withoutConsole<T>(fn: () => T): T {
  const saved = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = () => {}
  try {
    return fn()
  } finally {
    Object.assign(console, saved)
  }
}

function projectWithEmulatorLogs(): string {
  const cwd = tempProject()
  withoutConsole(() => {
    initLogger({ appId: 'local-app', logLocalDir: path.join(cwd, '.fsl-logs') })
    writeLog({ message: 'cart sync failed', severity: 'ERROR', labels: { appId: 'local-app', screen: 'Cart', userId: 'u1' } as never, jsonPayload: { error: { message: 'boom', name: 'Error' } }, functionName: 'checkout' })
    writeLog({ message: 'cart sync failed', severity: 'ERROR', labels: { appId: 'local-app', screen: 'Cart' } as never, functionName: 'checkout' })
    writeLog({ message: 'opened home', severity: 'INFO', labels: { appId: 'local-app', screen: 'Home' } as never })
  })
  return cwd
}

async function testLocalReadsWhatTheEmulatorWrote() {
  const cwd = projectWithEmulatorLogs()
  console.log('\nTest: --local answers the same questions from .fsl-logs/dev.jsonl')
  const errors = await runFsl(['--local', '--where', 'severity=ERROR', '--select', 'message,labels.screen,functionName'], { cwd })
  const lines = errors.stdout.map((l) => JSON.parse(l) as Record<string, unknown>)
  assert('exits 0', errors.code === 0, errors.stderr.join('\n'))
  assert('two errors', lines.length === 2, errors.stdout.join('\n'))
  assert('same fields as the cloud output', lines[0].message === 'cart sync failed' && lines[0]['labels.screen'] === 'Cart' && lines[0].functionName === 'checkout', JSON.stringify(lines[0]))
  assert('the cloud transport was never used', errors.cloudRequests.length === 0)

  const grouped = await runFsl(['--local', '--group-by', 'labels.screen', '--select', 'labels.screen,count', '--order-by', 'count desc'], { cwd })
  assert('group by works on files', grouped.stdout[0] === '{"labels.screen":"Cart","count":2}', grouped.stdout.join('\n'))

  const nested = await runFsl(['--local', '--where', 'jsonPayload.error.message=boom', '--select', 'message'], { cwd })
  assert('a payload path filters', nested.stdout.length === 1)

  const typo = await runFsl(['--local', '--where', 'labels.screnn=Cart'], { cwd })
  assert('the fix-it error is the same locally', typo.stderr.join('\n').includes('Did you mean labels.screen?'))

  const schema = await runFsl(['schema', '--local', '--json'], { cwd })
  const labels = (JSON.parse(schema.stdout[0]) as { fromLogs: { labels: Record<string, { count: number; samples: string[] }> } }).fromLogs.labels
  assert('schema counts local labels', labels.screen.count === 3 && labels.logId.count === 3 && labels.userId.count === 1)
  assert('userId has no samples locally either', labels.userId.samples.length === 0)
}

async function testCliProcessReadsLocalFiles() {
  console.log('\nTest: the real CLI process prints one JSON entry per line from --local')
  const cwd = projectWithEmulatorLogs()
  const out = spawnSync('npx', ['tsx', CLI, 'logs', '--local', '--select', 'severity,message', '--limit', '2'], { cwd, encoding: 'utf-8' })
  assert('exit code 0', out.status === 0, out.stderr)
  const lines = out.stdout.trim().split('\n')
  assert('two JSON lines', lines.length === 2 && lines.every((l) => JSON.parse(l).message !== undefined), out.stdout)
  assert('the cut was reported on stderr', out.stderr.includes('truncated: 2 shown, 1 more.'), out.stderr)
  const bad = spawnSync('npx', ['tsx', CLI, 'logs', '--bogus'], { cwd, encoding: 'utf-8' })
  assert('an unknown flag exits 1', bad.status === 1 && bad.stderr.includes('Valid flags'), bad.stderr)
  assert('and writes nothing to stdout', bad.stdout === '')
  assert('schema.json is not created by a failed run', !fs.existsSync(path.join(cwd, '.fsl-logs', 'schema.json')))
}

async function testEmulatorFolderIgnoresItself() {
  console.log('\nTest: the emulator logger gives logLocalDir a .gitignore of * and keeps an existing one')
  const cwd = tempProject()
  const dir = path.join(cwd, 'custom-logs')
  withoutConsole(() => initLogger({ appId: 'local-app', logLocalDir: dir }))
  assert('.gitignore is *', fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8') === '*\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'mine\n')
  withoutConsole(() => initLogger({ appId: 'local-app', logLocalDir: dir }))
  assert('an existing .gitignore is not overwritten', fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8') === 'mine\n')
}

async function testRotationToleratesFilesAnotherWorkerAlreadyMoved() {
  console.log('\nTest: rotating logs warns about nothing when there is no previous file, and keeps the newest backups')
  const dir = path.join(tempProject(), 'rotating-logs')
  const warnings: string[] = []
  const savedWarn = console.warn
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
  try {
    initLogger({ appId: 'local-app', logLocalDir: dir })
    assert('no previous dev.jsonl is not a failure', warnings.length === 0, warnings.join('|'))

    for (const day of ['01', '02', '03']) fs.writeFileSync(path.join(dir, `dev-2020-01-${day}.jsonl`), '')
    fs.writeFileSync(path.join(dir, 'dev.jsonl'), '{}\n')
    initLogger({ appId: 'local-app', logLocalDir: dir, logMaxRotatedFiles: 2 })
  } finally {
    console.warn = savedWarn
  }
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('dev-')).sort()
  assert('the current file was moved aside', !fs.existsSync(path.join(dir, 'dev.jsonl')))
  assert('only the newest two backups remain', backups.length === 2 && !backups.includes('dev-2020-01-01.jsonl'), backups.join(','))
  assert('and nothing was warned', warnings.length === 0, warnings.join('|'))
}

async function main() {
  await testLocalReadsWhatTheEmulatorWrote()
  await testCliProcessReadsLocalFiles()
  await testEmulatorFolderIgnoresItself()
  await testRotationToleratesFilesAnotherWorkerAlreadyMoved()
  reportResults()
}

main()
