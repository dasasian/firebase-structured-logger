import { AsyncLocalStorage } from 'async_hooks'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { createLogWriter, type LogWriter } from './logger'

const storage = new AsyncLocalStorage<LogWriter>()

/**
 * Initialize a request-scoped logger and store it in AsyncLocalStorage.
 * Call at the start of every onCall handler.
 *
 * Pass AppLabels as a type parameter to get typed label checking on the `labels` field.
 * Any labels passed here are seeded on every log call in the request.
 *
 * @example
 * export const myFunc = onCall(async (request) => {
 *   initRequestLogger<AppLabels>(request, {
 *     functionName: 'myFunc',
 *     labels: { organizationId: request.data.organizationId },
 *   })
 *   logInfo('started')
 * })
 */
export function initRequestLogger<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
>(
  request: CallableRequest,
  extra?: { functionName?: string; appId?: string; labels?: Partial<AppLabels> },
): LogWriter {
  const labels: Record<string, string | undefined> = {
    functionName: extra?.functionName,
    userId: request.auth?.uid,
    appId: extra?.appId,
    ...extra?.labels,
  }

  // Remove undefined values
  const cleanLabels = Object.fromEntries(
    Object.entries(labels).filter(([, v]) => v !== undefined),
  ) as Record<string, string>

  const writer = createLogWriter(cleanLabels)
  storage.enterWith(writer)
  return writer
}

/**
 * Retrieve the request-scoped logger. Throws if called outside a request context.
 */
export function getLogger(): LogWriter {
  const writer = storage.getStore()
  if (!writer) {
    throw new Error('[fsl] getLogger() called outside of a request — call initRequestLogger() first')
  }
  return writer
}
