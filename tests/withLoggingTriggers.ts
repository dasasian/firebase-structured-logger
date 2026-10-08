/**
 * Type test: withLogging wraps the handlers of onCall, onSchedule and onTaskDispatched.
 *
 * Nothing here runs. `npm run typecheck` is the test: if one of these stops
 * type-checking, tsc fails.
 */

import { onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { onSchedule, type ScheduledEvent } from 'firebase-functions/v2/scheduler'
import { onTaskDispatched, type Request } from 'firebase-functions/v2/tasks'
import { withLogging } from '../src/functions/requestLogger.js'

type AppLabels = { orgId?: string }

export const callable = onCall(
  withLogging<AppLabels>({ functionName: 'callable' }, async (request) => {
    const typed: CallableRequest = request
    return typed.data
  }),
)

export const scheduled = onSchedule(
  'every 5 minutes',
  withLogging<AppLabels, ScheduledEvent>({ functionName: 'scheduled' }, async (event) => {
    const scheduleTime: string = event.scheduleTime
    void scheduleTime
  }),
)

export const dispatched = onTaskDispatched(
  { retryConfig: { maxAttempts: 1 } },
  withLogging<AppLabels, Request<{ id: string }>>(
    (request) => ({ functionName: 'dispatched', labels: { orgId: request.data.id } }),
    async (request) => {
      const id: string = request.data.id
      void id
    },
  ),
)
