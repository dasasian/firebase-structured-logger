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
import { assert, reportResults, readLastEntry, clearLog, makeRequest } from './testHelpers.js'

// Init Firebase Admin (needed by writeLog for storage attachments etc.)
initializeApp({ projectId: 'acme-app-12345' })

// Init FSL logger in emulator mode — writes to LOG_DIR/dev.jsonl
fs.mkdirSync(LOG_DIR, { recursive: true })
initLogger({ appId: 'acme', logLocalDir: LOG_DIR })

const handler = createClientLogHandler({})

// --- Tests ---

async function testErrorPayloadStructure() {
  console.log('\nTest: error payload — error separate from context, no duplicate')
  clearLog(LOG_DIR)

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

  const entry = readLastEntry(LOG_DIR)
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

async function testInvalidPayloadRejected() {
  console.log('\nTest: invalid payload throws HttpsError')
  clearLog(LOG_DIR)

  let threw = false
  try {
    await handler(makeRequest({ message: '', severity: 'ERROR', labels: { appId: 'acme' } }))
  } catch (e: any) {
    threw = true
    assert('throws HttpsError for missing message', e?.code === 'invalid-argument' || e?.httpErrorCode?.status === 400)
  }
  assert('invalid payload was rejected', threw)
}


async function testUnknownSeverityInEmulatorMode() {
  console.log('\nTest: an unknown severity is coerced on the emulator branch too')
  clearLog(LOG_DIR)

  // The emulator branch has its OWN dispatch table (CONSOLE_FN), separate from
  // ffWrite's. Guarding one and not the other would leave the crash reachable
  // in whichever branch was missed — and the emulator is where it would look
  // fine while production burned.
  const { writeLog } = await import('../src/functions/logger.js')
  let threw = false
  try {
    writeLog({ message: 'bad severity, emulator', severity: 'DEFAULT' as never, labels: { appId: 'acme' } as never })
  } catch {
    threw = true
  }

  assert('nothing was thrown', !threw)
  const entry = readLastEntry(LOG_DIR)
  assert('the entry was written to JSONL', !!entry)
  assert('coerced to ERROR', entry?.severity === 'ERROR', `got: ${entry?.severity}`)
  assert('the message is intact', entry?.message === 'bad severity, emulator')
}

// --- Runner ---

async function run() {
  await testErrorPayloadStructure()
  await testInvalidPayloadRejected()
  await testUnknownSeverityInEmulatorMode()

  // Cleanup
  fs.rmSync(LOG_DIR, { recursive: true, force: true })

  reportResults()
}

run().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
