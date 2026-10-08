import { bc } from '@dasasian/firebase-structured-logger/client'
import { Modal } from './Modal'

export function Checkout() {
  return (
    <main>
      <button onClick={() => bc.action('apply_discount')}>Apply code</button>
      <Modal name="ConfirmOrder">
        <p>Place this order?</p>
      </Modal>
    </main>
  )
}
