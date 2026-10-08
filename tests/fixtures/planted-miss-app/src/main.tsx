import { createBrowserRouter, RouterProvider } from 'react-router'
import { createRoot } from 'react-dom/client'
import { initLogger } from '@dasasian/firebase-structured-logger/client'
import { enableReactRouterNavigation } from '@dasasian/firebase-structured-logger/client/navigation/react-router'
import { Checkout } from './Checkout'
import { Legacy } from './Legacy'

export const logger = initLogger({
  appId: 'planted-miss',
  releaseId: import.meta.env.VITE_RELEASE_ID ?? 'dev',
  logFunction: async (payload) => {
    await fetch('/log', { method: 'POST', body: JSON.stringify(payload) })
  },
})

const router = createBrowserRouter([
  { path: '/checkout', element: <Checkout /> },
  { path: '/old-orders', element: <Legacy /> },
])

enableReactRouterNavigation(router)

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
