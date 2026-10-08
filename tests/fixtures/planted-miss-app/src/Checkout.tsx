import { bc } from '@dasasian/firebase-structured-logger/client'
import { logger } from './main'
import { ConfirmDialog } from './ConfirmDialog'

export function Checkout() {
  bc.nav('Checkout')
  logger.setScreen('Checkout')
  return (
    <main>
      <button onClick={() => bc.action('apply_discount')}>Apply code</button>
      <ConfirmDialog />
    </main>
  )
}
