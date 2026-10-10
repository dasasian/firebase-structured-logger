declare global {
  interface ImportMeta {
    readonly env: Record<string, string | undefined>
  }
}

import { initLogger, setupGlobalErrorHandler } from '../../src/client/index.js'
import { getFunctions, httpsCallable } from 'firebase/functions'

export const logger = initLogger({
  appId: 'my-app',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
  logFunction: httpsCallable(getFunctions(), 'logFrontendEvent'),
})

setupGlobalErrorHandler()
