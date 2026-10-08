import { createBrowserRouter, RouterProvider } from 'react-router'
import { createRoot } from 'react-dom/client'
import { initLogger, setupGlobalErrorHandler } from '@dasasian/firebase-structured-logger/client'
import { enableReactRouterNavigation } from '@dasasian/firebase-structured-logger/client/navigation/react-router'
import { enableViews } from '@dasasian/firebase-structured-logger/client/views'
import { Checkout } from './Checkout'
import { Legacy } from './Legacy'

export const logger = initLogger({
  appId: 'clean-app',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
  minSeverity: 'INFO',
  logFunction: async (payload) => {
    await fetch('/log', { method: 'POST', body: JSON.stringify(payload) })
  },
})

setupGlobalErrorHandler()

const router = createBrowserRouter([
  { path: '/checkout', element: <Checkout />, handle: { screen: 'Checkout' } },
  { path: '/old-orders', element: <Legacy /> },
])

enableReactRouterNavigation(router)
enableViews()

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
