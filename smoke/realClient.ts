/**
 * The real `/client` logger, run in jsdom, sending through the deployed `fslSmokeClient`.
 *
 * Started by `smoke/run.ts` as a child process, so jsdom's globals never exist in the
 * process that talks to Google. Everything it needs arrives in the environment; it
 * prints nothing that holds the callable's URL and exits non-zero if any send failed.
 */

import { jsdomWindow, setVisibility } from '../tests/browserStubs.js'
import { initLogger } from '../src/client/logger.js'
import { bc } from '../src/client/breadcrumbs.js'
import { enableActions } from '../src/client/actions.js'
import { navigatedTo } from '../src/client/navigation.js'
import type { LogPayload } from '../src/shared/types.js'

const SCREEN = 'Checkout'
const ATTEMPTS_PER_PATH = 4

interface RealClientEnv {
  callableUrl: string
  appId: string
  releaseId: string
  runId: string
  errorMessage: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function readEnv(): RealClientEnv {
  return {
    callableUrl: requiredEnv('FSL_SMOKE_CALLABLE_URL'),
    appId: requiredEnv('FSL_SMOKE_APP_ID'),
    releaseId: requiredEnv('FSL_SMOKE_RELEASE_ID'),
    runId: requiredEnv('FSL_SMOKE_RUN_ID'),
    errorMessage: requiredEnv('FSL_SMOKE_ERROR_MESSAGE'),
  }
}

const env = readEnv()
const sendsInFlight = new Set<Promise<void>>()
let failedSends = 0

async function postToCallable(payload: LogPayload): Promise<void> {
  const res = await fetch(env.callableUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: payload }),
  })
  if (!res.ok) throw new Error(`the callable answered ${res.status}`)
}

function logFunction(payload: LogPayload): Promise<void> {
  const sending = postToCallable(payload)
  sendsInFlight.add(sending)
  sending.catch(() => void failedSends++).finally(() => sendsInFlight.delete(sending))
  return sending
}

const logger = initLogger<{ smokeRunId: string }>({
  appId: env.appId,
  releaseId: env.releaseId,
  minSeverity: 'DEBUG',
  logFunction,
})
logger.setUser('smoke-user', { smokeRunId: env.runId })
enableActions()

const page = jsdomWindow.document
page.body.innerHTML = `
  <button id="edit-quantity" data-fsl-action="edit_quantity">Edit quantity</button>
  <button id="place-order" data-fsl-action="tap_place_order">Place order</button>
`

function clickMarkedButton(id: string): void {
  const button = page.getElementById(id)
  if (!button) throw new Error(`no #${id} on the page`)
  button.click()
}

function failCheckout(): void {
  logger.error(new Error(env.errorMessage))
}

function actionsInCode(): void {
  bc.action('apply_discount')
  bc.action('tap_place_order')
  failCheckout()
}

function actionsFromMarkup(): void {
  clickMarkedButton('edit-quantity')
  clickMarkedButton('place-order')
  failCheckout()
}

function arriveOnTheScreenAndTry(path: () => void): void {
  navigatedTo(SCREEN)
  path()
}

async function main(): Promise<void> {
  for (const path of [actionsInCode, actionsFromMarkup]) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_PATH; attempt++) arriveOnTheScreenAndTry(path)
  }
  setVisibility('hidden')
  await Promise.allSettled([...sendsInFlight])
  if (failedSends > 0) throw new Error(`${failedSends} sends failed`)
  console.log('  the real client sent every entry')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => process.exit())
