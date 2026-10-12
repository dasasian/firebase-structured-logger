/**
 * The process that tests/localLogFile.ts starts with a chosen environment. The logger reads
 * FUNCTIONS_EMULATOR, K_SERVICE and NODE_ENV when its module loads, so each environment
 * needs its own process. This file prints nothing of its own: the parent compares
 * what the logger printed.
 *
 * Arguments: <scenario> <log folder, or - for none>
 */

import { initializeApp } from 'firebase-admin/app'
import { initLogger, writeLog } from '../src/functions/logger.js'
import { createClientLogHandler } from '../src/functions/logHandler.js'
import { createHttpLogHandler, type HttpLogResponse } from '../src/functions/httpHandler.js'
import { makeRequest } from './testHelpers.js'

process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9'
initializeApp({ projectId: 'demo-local-log-file' })

const [scenario, logFolder] = process.argv.slice(2)
const folderOption = logFolder === '-' ? {} : { logLocalDir: logFolder }

const ERROR_ENTRY = {
  message: 'cart sync failed',
  severity: 'ERROR' as const,
  labels: { appId: 'dev-app', screen: 'Cart', userId: 'u1' } as never,
  jsonPayload: { error: { message: 'boom', name: 'Error' } },
}

async function run(): Promise<void> {
  if (scenario === 'rotation') {
    initLogger({ appId: 'dev-app', ...folderOption, logMaxRecordsPerFile: 2 })
    for (let i = 0; i < 3; i++) writeLog({ ...ERROR_ENTRY, message: `entry ${i}` })
    return
  }

  initLogger({ appId: 'dev-app', ...folderOption })
  if (scenario === 'direct') {
    writeLog(ERROR_ENTRY)
  } else if (scenario === 'callable') {
    await createClientLogHandler()(makeRequest({ ...ERROR_ENTRY, labels: { appId: 'dev-app', screen: 'Cart' } as never }))
  } else if (scenario === 'http') {
    const res: HttpLogResponse = { statusCode: 0, setHeader() {}, end() {} }
    await createHttpLogHandler({ authorize: 'unauthenticated' })(
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: { ...ERROR_ENTRY, labels: { appId: 'dev-app', screen: 'Cart' } } },
      res,
    )
  } else {
    throw new Error(`unknown scenario ${scenario}`)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
