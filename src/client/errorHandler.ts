import { getClientLogger } from './logger'

export function setupGlobalErrorHandler(): void {
  window.addEventListener('error', (event) => {
    console.error('[fsl] Uncaught error:', event.error)
    getClientLogger().error(event.error, { errorCategory: 'crash', errorType: 'UncaughtError' } as never)
  })

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[fsl] Unhandled rejection:', event.reason)
    getClientLogger().error(event.reason, { errorCategory: 'crash', errorType: 'UnhandledRejection' } as never)
  })
}

export function handleReactError(
  error: Error,
  errorInfo: { componentStack: string },
): void {
  getClientLogger().error(
    error,
    { errorCategory: 'crash', errorType: 'ReactError' } as never,
    { componentStack: errorInfo.componentStack },
  )
}
