/**
 * The Express mount that CAPABILITIES.md and the createHttpLogHandler doc comment show.
 *
 * Express answers an OPTIONS request itself when the route is registered with app.post, so
 * the handler's own preflight answer never runs and a browser on another origin is blocked.
 * This drives a real Express app on a real local port with fetch.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/expressMount.ts
 */

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { AddressInfo } from 'net'
import express from 'express'
import { initializeApp } from 'firebase-admin/app'
import { initLogger } from '../src/functions/logger.js'
import { createHttpLogHandler } from '../src/functions/httpHandler.js'
import { assert, reportResults } from './testHelpers.js'

initializeApp({ projectId: 'demo-express-mount' })

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-express-'))
initLogger({ appId: 'express-app', logLocalDir: LOG_DIR, minSeverity: 'DEBUG' })

const BROWSER_ORIGIN = 'https://app.example.com'

async function runAgainstDocumentedMount(): Promise<void> {
  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.all('/log', createHttpLogHandler({ authorize: async () => true }))

  const server = app.listen(0)
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}/log`

  try {
    console.log('\nTest: a cross-origin preflight reaches the handler')
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: BROWSER_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    })
    assert('OPTIONS answers 204', preflight.status === 204, `got ${preflight.status}`)
    assert(
      'with Access-Control-Allow-Origin',
      preflight.headers.get('access-control-allow-origin') === '*',
      String(preflight.headers.get('access-control-allow-origin')),
    )
    assert(
      'with Access-Control-Allow-Methods',
      preflight.headers.get('access-control-allow-methods') === 'POST, OPTIONS',
      String(preflight.headers.get('access-control-allow-methods')),
    )
    assert(
      'with Access-Control-Allow-Headers',
      /authorization/i.test(preflight.headers.get('access-control-allow-headers') ?? ''),
      String(preflight.headers.get('access-control-allow-headers')),
    )

    console.log('\nTest: POST and GET still behave')
    const posted = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BROWSER_ORIGIN },
      body: JSON.stringify({ message: 'hello', severity: 'INFO', labels: { appId: 'express-app' } }),
    })
    assert('POST answers 204', posted.status === 204, `got ${posted.status}`)
    const got = await fetch(url, { method: 'GET' })
    assert('GET answers 405', got.status === 405, `got ${got.status}`)
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

runAgainstDocumentedMount()
  .then(() => {
    fs.rmSync(LOG_DIR, { recursive: true, force: true })
    reportResults()
  })
  .catch((err) => {
    fs.rmSync(LOG_DIR, { recursive: true, force: true })
    console.error('Fatal:', err)
    process.exit(1)
  })
