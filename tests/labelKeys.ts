/**
 * `BaseLabels` names every label key the loggers write.
 *
 * `BaseLabels` is the reference for what fsl writes — the shipped `.d.ts` and the list
 * `fsl logs` validates `--where labels.<key>` against — so a label the loggers emit
 * and the type forgets is a field an agent is told does not exist. This suite drives
 * the client logger and the functions logger (production branch, hence the flag unset)
 * through the scenarios that emit labels — user, route, view, crash, repeat copies and
 * summary, feedback, attachments, an oversize entry, a slow trace — collects every
 * key from what was actually sent, and fails on any the type does not declare.
 *
 * Run: npx tsx tests/labelKeys.ts
 */

if (process.env.FUNCTIONS_EMULATOR === 'true') {
  console.error('Run with FUNCTIONS_EMULATOR unset — attachments and truncation are production-branch labels')
  process.exit(1)
}

import { sessionStorageStub, localStorageStub, withFrozenTime, setVisibility, dispatchErrorEvent } from './browserStubs.js'
import fs from 'fs'
import path from 'path'
import { initializeApp } from 'firebase-admin/app'
import { initLogger as initClientLogger, sendFeedback } from '../src/client/logger.js'
import { configureRateLimiter, resetRateLimiter } from '../src/client/rateLimiter.js'
import { setupGlobalErrorHandler } from '../src/client/errorHandler.js'
import { navigatedTo } from '../src/client/navigation.js'
import { enableViews } from '../src/client/views.js'
import { initLogger as initFunctionsLogger, writeLog } from '../src/functions/logger.js'
import { configureAttachments, resetAttachmentConfig } from '../src/functions/sourceMapCache.js'
import { traceLabels } from '../src/shared/trace.js'
import { BASE_LABEL_KEYS, type BaseLabels } from '../src/shared/types.js'
import { assert, reportResults } from './testHelpers.js'

process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9'
initializeApp({ projectId: 'demo-label-keys' })

type DeclaredButNotListed = Exclude<keyof BaseLabels, (typeof BASE_LABEL_KEYS)[number]>
const everyDeclaredKeyIsListed: DeclaredButNotListed extends never ? true : never = true

const observed = new Map<string, string>()

function observe(source: string, labels: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (value !== undefined && !observed.has(key)) observed.set(key, source)
  }
}

function keysDeclaredInBaseLabels(): string[] {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'shared', 'types.ts'), 'utf-8')
  const body = source.slice(source.indexOf('export interface BaseLabels'), source.indexOf('export const BASE_LABEL_KEYS'))
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1])
}

function captureWrites(fn: () => void): Record<string, unknown>[] {
  const lines: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const grab = ((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stdout.write = grab
  process.stderr.write = grab
  try {
    fn()
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
  return lines
    .join('')
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function driveClientLogger() {
  const sent: { labels: Record<string, unknown> }[] = []
  const logger = initClientLogger({ appId: 'label-keys', releaseId: 'r1', minSeverity: 'DEBUG', logFunction: async (payload) => void sent.push(payload) })
  configureRateLimiter({ burstLimit: 1000, duplicateLimit: 3, storageKey: 'fsl_ratelimit', summaryIntervalMinutes: 60 })
  resetRateLimiter()
  localStorageStub.setItem('fsl_pending_summaries', '[]')
  sessionStorageStub.failing = false

  logger.setUser('u1')
  enableViews()
  document.body.innerHTML = '<div data-fsl-view="payment"></div>'
  navigatedTo('Checkout', { route: '/orders/:id', path: '/orders/1' })
  await logger.info('hello')

  setupGlobalErrorHandler()
  dispatchErrorEvent({ message: 'boom', error: new TypeError('boom') })

  const t0 = Date.now()
  for (let i = 0; i < 6; i++) withFrozenTime(t0 + i * 1000, () => void logger.error(new Error('cart sync failed')))
  await new Promise((resolve) => setTimeout(resolve, 10))
  withFrozenTime(t0 + 61 * 60_000, () => setVisibility('hidden'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  setVisibility('visible')

  sendFeedback('the discount did not apply')
  await new Promise((resolve) => setTimeout(resolve, 10))
  for (const payload of sent) observe('client logger', payload.labels)
}

function driveFunctionsLogger() {
  initFunctionsLogger({ appId: 'label-keys', minSeverity: 'DEBUG' })
  const baseLabels = { appId: 'label-keys', userId: 'u1' } as never
  configureAttachments({ bucket: 'demo-label-keys' })
  const written = captureWrites(() => {
    writeLog({ message: 'plain', severity: 'INFO', labels: baseLabels })
    writeLog({ message: 'with file', severity: 'INFO', labels: baseLabels, attachments: { note: Buffer.from('hi').toString('base64') } })
    writeLog({
      message: 'too big',
      severity: 'ERROR',
      labels: baseLabels,
      jsonPayload: { context: { blob: 'x'.repeat(300 * 1024) }, error: { message: 'boom', name: 'Error', stack: 'Error: boom\n    at a.ts:1:1' } },
    })
  })
  resetAttachmentConfig()
  for (const entry of written) observe('functions logger', entry['logging.googleapis.com/labels'] as Record<string, unknown>)
  observe('trace', traceLabels('checkout', 'RUN1', { slow: 'step', step: 'charge', elapsedMs: 5, limitMs: 1, steps: [], waiting: [] } as never))
}

async function main() {
  const realWarn = console.warn
  console.warn = () => {}
  console.log('\nTest: every label the loggers write is declared on BaseLabels')
  const realError = console.error
  console.error = () => {}
  await driveClientLogger()
  console.error = realError
  driveFunctionsLogger()
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 1))
  console.warn = realWarn

  const declared = new Set(keysDeclaredInBaseLabels())
  const missing = [...observed].filter(([key]) => !declared.has(key)).map(([key, source]) => `${key} (${source})`)
  assert('the scenarios emitted labels', observed.size > 15, [...observed.keys()].join(', '))
  assert('BaseLabels declares every observed key', missing.length === 0, `missing from BaseLabels: ${missing.join(', ')}`)
  for (const key of ['repeatKey', 'repeatOf', 'repeatCount', 'firstSeen', 'lastSeen', 'logId', 'hasAttachments', 'truncated', 'feedback', 'view', 'errorCategory', 'trace', 'run', 'slow', 'step']) {
    assert(`${key} was observed`, observed.has(key))
  }
  assert('BASE_LABEL_KEYS lists exactly the declared keys', [...BASE_LABEL_KEYS].sort().join() === [...declared].sort().join(), `${[...BASE_LABEL_KEYS].sort().join()} vs ${[...declared].sort().join()}`)
  assert('compile-time: every declared key is listed', everyDeclaredKeyIsListed)
  reportResults()
}

main()
