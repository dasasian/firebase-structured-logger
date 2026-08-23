import { getClientLogger } from './logger'

/**
 * A script loaded cross-origin without CORS has its error withheld by the
 * browser: the event fires with `error === null` and only `message`
 * (classically `"Script error."`), `filename`, `lineno` and `colno` are set.
 *
 * Passing that null straight to the logger produced an entry whose message was
 * the literal string "null" — less information than the event carried, and
 * identical for every such error, so they were indistinguishable in Cloud
 * Logging and collapsed into a single signature that duplicate suppression
 * then swallowed. The locator is folded into the message so the entries stay
 * distinct as well as readable.
 */
function errorFromEvent(event: ErrorEvent): Error {
  const where = event.filename
    ? ` (${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0})`
    : ''
  return new Error(`${event.message || 'Cross-origin script error'}${where}`)
}

export function setupGlobalErrorHandler(): void {
  window.addEventListener('error', (event) => {
    if (event.error != null) {
      console.error('[fsl] Uncaught error:', event.error)
      getClientLogger().error(event.error, {
        errorCategory: 'crash',
        errorType: 'UncaughtError',
      })
      return
    }

    console.error('[fsl] Cross-origin script error:', event.message)
    getClientLogger().error(
      errorFromEvent(event),
      { errorCategory: 'crash', errorType: 'CrossOriginError' },
      { filename: event.filename, lineno: event.lineno, colno: event.colno },
    )
  })

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[fsl] Unhandled rejection:', event.reason)
    // A rejection can carry any value, including none at all. `toError` would
    // turn that into Error("undefined"), which says nothing.
    const reason =
      event.reason ?? new Error('Unhandled promise rejection with no reason')
    getClientLogger().error(reason, {
      errorCategory: 'crash',
      errorType: 'UnhandledRejection',
    })
  })
}

export function handleReactError(
  error: Error,
  errorInfo: { componentStack: string },
): void {
  getClientLogger().error(
    error,
    { errorCategory: 'crash', errorType: 'ReactError' },
    { componentStack: errorInfo.componentStack },
  )
}
