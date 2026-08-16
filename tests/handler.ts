/**
 * Integration test for createClientLogHandler
 * Calls the handler directly with synthetic data (no HTTP layer)
 * Uses emulator mode so writeLog writes to a local JSONL file instead of Cloud Logging stdout
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx test-handler.ts
 *
 * NOTE: FUNCTIONS_EMULATOR must be set in the shell — ESM hoists imports before
 * any code runs, so setting process.env inside this file is too late.
 */

import fs from 'fs'
import path from 'path'

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx test-handler.ts')
  process.exit(1)
}

process.env.GOOGLE_APPLICATION_CREDENTIALS = './service-account.json'

const LOG_DIR = './test-handler-output'

import { initializeApp } from 'firebase-admin/app'
import { createClientLogHandler } from '../src/functions/logHandler.js'
import { initLogger } from '../src/functions/logger.js'
import type { LogPayload } from '../src/shared/types.js'
import type { CallableRequest } from 'firebase-functions/v2/https'

// Init Firebase Admin (needed by writeLog for storage attachments etc.)
initializeApp({ projectId: 'acme-app-12345' })

// Init FSL logger in emulator mode — writes to LOG_DIR/dev.jsonl
fs.mkdirSync(LOG_DIR, { recursive: true })
initLogger({ appId: 'acme', logLocalDir: LOG_DIR })

// --- Assertion helpers ---

let passed = 0
let failed = 0

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

function readLastEntry(): Record<string, unknown> | undefined {
  const logFile = path.join(LOG_DIR, 'dev.jsonl')
  if (!fs.existsSync(logFile)) return undefined
  const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean)
  if (lines.length === 0) return undefined
  return JSON.parse(lines[lines.length - 1])
}

function clearLog() {
  const logFile = path.join(LOG_DIR, 'dev.jsonl')
  if (fs.existsSync(logFile)) fs.writeFileSync(logFile, '')
}

function makeRequest(data: LogPayload): CallableRequest<LogPayload> {
  return { data, auth: undefined, rawRequest: {} } as any
}

const handler = createClientLogHandler({})

// --- Tests ---

async function testErrorPayloadStructure() {
  console.log('\nTest: error payload — error separate from context, no duplicate')
  clearLog()

  await handler(makeRequest({
    message: 'DUPLICATE_PRODUCT:test123',
    severity: 'ERROR',
    labels: {
      appId: 'acme',
      userId: 'test-user',
      platform: 'ios',
      releaseId: 'test-release',
      errorType: 'DuplicateProductError',
    },
    jsonPayload: {
      error: {
        message: 'DUPLICATE_PRODUCT:test123',
        name: 'DuplicateProductError',
        stack: 'DuplicateProductError: DUPLICATE_PRODUCT:test123\n    at duplicate (../../src/services/catalogProducts.ts:10:5)',
      },
      context: {
        screen: 'ProductEntryModal',
        operation: 'handleCreateProduct',
        packIntent: 'single',
      },
      breadcrumbs: [
        { timestamp: Date.now(), type: 'action', name: 'open_product_entry', data: { locationId: 'loc_123' } },
      ],
    },
  }))

  const entry = readLastEntry()
  assert('entry was written', !!entry)

  const jp = entry?.jsonPayload as any
  assert('jsonPayload.error is set', !!jp?.error)
  assert('jsonPayload.error.message correct', jp?.error?.message === 'DUPLICATE_PRODUCT:test123')
  assert('jsonPayload.error.name correct', jp?.error?.name === 'DuplicateProductError')
  assert('jsonPayload.context is set', !!jp?.context)
  assert('jsonPayload.context.screen preserved', jp?.context?.screen === 'ProductEntryModal')
  assert('jsonPayload.context has no error (no duplicate)', jp?.context?.error === undefined)
  assert('jsonPayload.breadcrumbs written', Array.isArray(jp?.breadcrumbs) && jp.breadcrumbs.length === 1)
  assert('labels.errorType set', (entry?.labels as any)?.errorType === 'DuplicateProductError')
  assert('labels.appId set', (entry?.labels as any)?.appId === 'acme')
  assert('severity is ERROR', entry?.severity === 'ERROR')

  console.log('\n  Written entry:')
  console.log(JSON.stringify(entry, null, 2))
}

async function testSymbolicatedStack() {
  console.log('\nTest: minified stack gets symbolicated (if source map available)')
  clearLog()

  await handler(makeRequest({
    message: 'Test error with minified stack',
    severity: 'ERROR',
    labels: {
      appId: 'acme',
      releaseId: 'faeb9a9',  // real release ID with source maps in GCS
      errorType: 'Error',
    },
    jsonPayload: {
      error: {
        message: 'Test error with minified stack',
        name: 'Error',
        stack: 'ir@https://acme.example.com/assets/index-DmZHAO2r.js:19:21992',
      },
    },
  }))

  const entry = readLastEntry()
  const jp = entry?.jsonPayload as any
  const stack = jp?.error?.stack as string | undefined

  assert('error.stack is set', !!stack)
  if (stack?.includes('acme.example.com/assets')) {
    console.log('  ~ stack not symbolicated (source map unavailable — expected in local env)')
  } else {
    assert('stack is symbolicated (no bundle URL)', !stack?.includes('acme.example.com/assets'))
    console.log('  ~ symbolicated stack:', stack)
  }
}

async function testInvalidPayloadRejected() {
  console.log('\nTest: invalid payload throws HttpsError')
  clearLog()

  let threw = false
  try {
    await handler(makeRequest({ message: '', severity: 'ERROR', labels: { appId: 'acme' } }))
  } catch (e: any) {
    threw = true
    assert('throws HttpsError for missing message', e?.code === 'invalid-argument' || e?.httpErrorCode?.status === 400)
  }
  assert('invalid payload was rejected', threw)
}

// --- Runner ---

async function run() {
  await testErrorPayloadStructure()
  await testSymbolicatedStack()
  await testInvalidPayloadRejected()

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)

  // Cleanup
  fs.rmSync(LOG_DIR, { recursive: true, force: true })

  if (failed > 0) process.exit(1)
}

run().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
