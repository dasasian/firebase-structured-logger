declare function chargeCard(data: unknown): Promise<void>

import { onCall } from 'firebase-functions/v2/https'
import { initLogger, createClientLogFunction, withLogging } from '../../src/functions/index.js'

initLogger({ appId: 'my-app' })

export const logFrontendEvent = createClientLogFunction({})

export const checkout = onCall(
  withLogging({ functionName: 'checkout' }, async (request) => {
    await chargeCard(request.data)
  }),
)
