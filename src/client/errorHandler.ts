import { getClientLogger } from './logger'

export function setupGlobalErrorHandler(): void {
  window.addEventListener('error', (event) => {
    console.error('[fsl] Uncaught error:', event.error)
    getClientLogger().error(event.error, { errorCategory: 'crash', errorType: 'UncaughtError' })
  })

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[fsl] Unhandled rejection:', event.reason)
    getClientLogger().error(event.reason, { errorCategory: 'crash', errorType: 'UnhandledRejection' })
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
