/**
 * Client attachment tests — the Blob → base64 path.
 *
 * `logger.ts` turns a Blob/File into base64 via FileReader.readAsDataURL before
 * sending. Nothing covered it: there was no Blob or FileReader in the test
 * environment until browserStubs moved to jsdom. This is the path a feedback
 * screenshot will ride (#9), so it should not stay unverified.
 *
 * Run: npx tsx tests/attachments.ts
 */

// Must come first — supplies Blob/FileReader, and the logger reads navigator
// at module load.
import './browserStubs.js'

import { initLogger } from '../src/client/logger.js'
import { configureRateLimiter, resetRateLimiter } from '../src/client/rateLimiter.js'
import type { LogPayload } from '../src/shared/types.js'
import { assert, reportResults } from './testHelpers.js'

function makeLogger(): { send: (a?: Record<string, Blob | File | string>) => void; last: () => LogPayload | undefined } {
  let captured: LogPayload | undefined
  configureRateLimiter({ sessionLimit: 500, duplicateLimit: 99 })
  resetRateLimiter()
  const logger = initLogger({
    appId: 'acme',
    releaseId: 'r1',
    minLogLevel: 'DEBUG',
    logFunction: async (data) => {
      captured = data
    },
  })
  return {
    send: (attachments) => logger.info('with attachment', undefined, undefined, attachments),
    last: () => captured,
  }
}

const flush = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 1))
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')

// --- Blob conversion ---

async function testBlobRoundTrip() {
  console.log('\nTest: a Blob is converted to base64')
  const { send, last } = makeLogger()

  send({ note: new Blob(['hello world'], { type: 'text/plain' }) })
  await flush()

  const got = last()?.attachments?.note
  assert('the attachment is present', !!got)
  assert('it is base64 of the content', got === b64('hello world'), `got: ${got}`)
  assert('the data: URL prefix was stripped', got?.includes(',') === false, `got: ${got}`)
}

async function testFileIsTreatedAsABlob() {
  console.log('\nTest: a File works the same way (File extends Blob)')
  const { send, last } = makeLogger()

  send({ shot: new File(['screenshot bytes'], 'shot.png', { type: 'image/png' }) })
  await flush()

  assert('the File converted', last()?.attachments?.shot === b64('screenshot bytes'), `got: ${last()?.attachments?.shot}`)
}

async function testStringPassesThroughUntouched() {
  console.log('\nTest: a string attachment short-circuits FileReader')
  const { send, last } = makeLogger()

  // assetToBase64 returns strings as-is — the caller is expected to have
  // encoded them already.
  send({ preencoded: 'YWxyZWFkeSBiYXNlNjQ=' })
  await flush()

  assert('the string is passed through unchanged', last()?.attachments?.preencoded === 'YWxyZWFkeSBiYXNlNjQ=')
}

async function testBinaryContentSurvives() {
  console.log('\nTest: binary content survives — a screenshot is the real use case')
  const { send, last } = makeLogger()

  // A PNG magic number plus bytes that are not valid UTF-8.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe])
  send({ png: new Blob([bytes], { type: 'image/png' }) })
  await flush()

  const got = last()?.attachments?.png
  assert('the attachment is present', !!got)
  assert(
    'the bytes round-trip exactly',
    got === Buffer.from(bytes).toString('base64'),
    `got: ${got}`,
  )
  assert(
    'decoding recovers the PNG magic number',
    got !== undefined && Buffer.from(got, 'base64')[0] === 0x89,
  )
}

async function testEmptyBlob() {
  console.log('\nTest: an empty Blob does not become undefined')
  const { send, last } = makeLogger()

  send({ empty: new Blob([]) })
  await flush()

  const got = last()?.attachments?.empty
  assert('the key is present', last()?.attachments !== undefined && 'empty' in last()!.attachments!)
  assert('the value is an empty string, not undefined', got === '', `got: ${JSON.stringify(got)}`)
}

async function testSeveralAttachments() {
  console.log('\nTest: several attachments in one call each convert')
  const { send, last } = makeLogger()

  send({
    a: new Blob(['first']),
    b: new Blob(['second']),
    c: 'third-already-encoded',
  })
  await flush()

  const got = last()?.attachments
  assert('all three are present', got !== undefined && Object.keys(got).length === 3, `got: ${JSON.stringify(got && Object.keys(got))}`)
  assert('first converted', got?.a === b64('first'), `got: ${got?.a}`)
  assert('second converted', got?.b === b64('second'), `got: ${got?.b}`)
  assert('the string passed through', got?.c === 'third-already-encoded')
}

// --- Absence ---

async function testNoAttachmentsKeyWhenNonePassed() {
  console.log('\nTest: the attachments key is omitted when there are none')
  const { send, last } = makeLogger()

  send()
  await flush()
  assert('no attachments key on the payload', last()?.attachments === undefined)

  send({})
  await flush()
  assert('an empty object also omits the key', last()?.attachments === undefined)
}


// --- Failure path ---

async function testUnreadableAttachmentDropsTheLogSilently() {
  console.log('\nTest: an unreadable attachment drops the whole log, silently')
  const { send, last } = makeLogger()

  // Something that is not a Blob and not a string. `assetToBase64` hands it to
  // FileReader.readAsDataURL, which rejects.
  send({ bad: { not: 'a blob' } as unknown as Blob })
  await flush()

  // Documenting the current behaviour rather than endorsing it: send() awaits
  // the conversion inside its try, so the rejection is swallowed by the generic
  // catch and the ENTIRE log is dropped — message, labels, breadcrumbs and all,
  // not just the attachment. A user reporting a crash with a broken screenshot
  // loses the crash report too.
  assert(
    'the log never reached logFunction',
    last() === undefined,
    `got: ${JSON.stringify(last()?.message)}`,
  )
}

// --- Runner ---

async function run() {
  await testBlobRoundTrip()
  await testFileIsTreatedAsABlob()
  await testStringPassesThroughUntouched()
  await testBinaryContentSurvives()
  await testEmptyBlob()
  await testSeveralAttachments()
  await testNoAttachmentsKeyWhenNonePassed()
  await testUnreadableAttachmentDropsTheLogSilently()
  reportResults()
}

run().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
