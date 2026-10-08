import { Navigate } from 'react-router'
import { bc } from '@dasasian/firebase-structured-logger/client'

export function Legacy() {
  bc.action('redirect_to_orders')
  return <Navigate to="/orders" replace />
}
