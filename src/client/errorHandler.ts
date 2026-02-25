import { getClientLogger } from './logger'

export function setupGlobalErrorHandler(): void {
  window.addEventListener('error', (event) => {
    getClientLogger()
      .error(event.error, { errorCategory: 'crash', errorType: 'UncaughtError' } as never)
      .catch(() => {
        console.error('[fsl] Uncaught error:', event.error)
      })
  })

  window.addEventListener('unhandledrejection', (event) => {
    getClientLogger()
      .error(event.reason, { errorCategory: 'crash', errorType: 'UnhandledRejection' } as never)
      .catch(() => {
        console.error('[fsl] Unhandled rejection:', event.reason)
      })
  })
}

export async function handleReactError(
  error: Error,
  errorInfo: { componentStack: string },
): Promise<void> {
  await getClientLogger().error(
    error,
    { errorCategory: 'crash', errorType: 'ReactError' } as never,
    { componentStack: errorInfo.componentStack },
  )
}
