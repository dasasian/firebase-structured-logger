/**
 * `enableActions()` and `data-fsl-action` — `@dasasian/firebase-structured-logger/client/actions` (#52).
 *
 * Every case drives real jsdom events against the document. jsdom does not turn a
 * keyboard Enter on a button into a `click` (a browser does), so the Enter case
 * dispatches the keydown and then the `click` a browser would send for it.
 *
 * Run: npx tsx tests/actions.ts
 */

import '../tests/browserStubs.js'

import { enableActions } from '../src/client/actions.js'
import { clearBreadcrumbs, getLastBreadcrumbs } from '../src/client/breadcrumbs.js'
import { initLogger } from '../src/client/logger.js'
import { setupGlobalErrorHandler } from '../src/client/errorHandler.js'
import { configureRateLimiter, resetRateLimiter } from '../src/client/rateLimiter.js'
import { assert, reportResults } from './testHelpers.js'
import { jsdomWindow } from './browserStubs.js'
import type { LogPayload } from '../src/shared/types.js'

const win = jsdomWindow
const doc = win.document
const globals = globalThis as Record<string, unknown>

let sent: LogPayload[] = []

initLogger({
  appId: 'actions-test',
  releaseId: 'r1',
  minSeverity: 'DEBUG',
  logFunction: async (data) => void sent.push(data),
})

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function setPage(html: string): void {
  doc.body.innerHTML = html
  clearBreadcrumbs()
  sent = []
}

function el<T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = doc): T {
  const found = root.querySelector<T>(`#${id}`)
  if (!found) throw new Error(`no #${id} in the test page`)
  return found
}

function crumbs() {
  return getLastBreadcrumbs(50)
}

function names(): string[] {
  return crumbs().map((c) => `${c.type}:${c.name}`)
}

function keyEvent(type: string, key: string): KeyboardEvent {
  return new win.KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true })
}

function change(target: HTMLElement): void {
  target.dispatchEvent(new win.Event('change', { bubbles: true }))
}

doc.addEventListener('submit', (event) => event.preventDefault())

function testOutsideABrowserItDoesNothing() {
  console.log('\nTest: outside a browser enableActions does nothing, and a later call in a browser still works')
  delete globals.document
  try {
    enableActions()
  } finally {
    globals.document = doc
  }
  setPage('<button id="b" data-fsl-action="apply_discount">Apply</button>')
  el('b').click()
  assert('no listener was added without a document', crumbs().length === 0, names().join(','))
}

function testClickOnMarkedButton() {
  console.log('\nTest: a click on a marked button records one action crumb with its name and no data')
  enableActions()
  setPage('<button id="b" data-fsl-action="apply_discount">Apply</button>')
  el('b').click()
  const all = crumbs()
  assert('exactly one crumb', all.length === 1, names().join(','))
  assert('it is an action named apply_discount', all[0]?.type === 'action' && all[0]?.name === 'apply_discount', JSON.stringify(all))
  assert('it carries no data', all[0]?.data === undefined, JSON.stringify(all[0]))
}

function testClickInsideMarkedButtonRecordsTheButton() {
  console.log('\nTest: a click on an element inside a marked button records the button\'s name')
  setPage('<button id="b" data-fsl-action="apply_discount"><span id="icon"><i id="glyph"></i></span>Apply</button>')
  el('glyph').click()
  assert('one crumb named for the button', names().join(',') === 'action:apply_discount', names().join(','))
}

function testNearestMarkWins() {
  console.log('\nTest: the nearest mark wins over an outer mark')
  setPage('<div data-fsl-action="card_opened"><button id="b" data-fsl-action="apply_discount">Apply</button><p id="p">text</p></div>')
  el('b').click()
  assert('the inner mark is recorded, not the outer', names().join(',') === 'action:apply_discount', names().join(','))
  clearBreadcrumbs()
  el('p').click()
  assert('a click outside the inner mark records the outer', names().join(',') === 'action:card_opened', names().join(','))
}

function testEnterOnMarkedButton() {
  console.log('\nTest: Enter on a marked button records it (the keydown, then the click a browser sends for it)')
  setPage('<button id="b" data-fsl-action="apply_discount">Apply</button>')
  const button = el('b')
  button.focus()
  button.dispatchEvent(keyEvent('keydown', 'Enter'))
  assert('jsdom itself sends no click for Enter, so nothing is recorded yet', crumbs().length === 0, names().join(','))
  button.click()
  button.dispatchEvent(keyEvent('keyup', 'Enter'))
  assert('the click that Enter produces is recorded once', names().join(',') === 'action:apply_discount', names().join(','))
}

function testSelectRecordsOnChangeNotOnClick() {
  console.log('\nTest: a marked select records on change, and a click on it records nothing')
  setPage('<select id="s" data-fsl-action="choose_shipping"><option>a</option><option>b</option></select>')
  const select = el('s')
  select.click()
  assert('a click records nothing', crumbs().length === 0, names().join(','))
  change(select)
  assert('change records the action', names().join(',') === 'action:choose_shipping', names().join(','))
}

function testInputAndTextareaRecordOnChange() {
  console.log('\nTest: a marked input and textarea record on change, not on click')
  setPage('<input id="i" data-fsl-action="coupon_edited"><textarea id="t" data-fsl-action="note_edited"></textarea>')
  el('i').click()
  el('t').click()
  assert('a click on either records nothing', crumbs().length === 0, names().join(','))
  change(el('i'))
  change(el('t'))
  assert('both record on change', names().join(',') === 'action:coupon_edited,action:note_edited', names().join(','))
}

function testCheckboxRecordsOnceBecauseTheBrowserChangesItOnClick() {
  console.log('\nTest: clicking a marked checkbox records once, from the change the browser fires, not from the click')
  setPage('<input id="i" type="checkbox" data-fsl-action="accept_terms">')
  el('i').click()
  assert('one crumb', names().join(',') === 'action:accept_terms', names().join(','))
}

function testChangeOnAnUnmarkedButtonMarkRecordsNothing() {
  console.log('\nTest: a change event whose nearest mark is a button records nothing')
  setPage('<button id="b" data-fsl-action="apply_discount">Apply</button>')
  change(el('b'))
  assert('nothing recorded', crumbs().length === 0, names().join(','))
}

function testFormRecordsOnceOnSubmit() {
  console.log('\nTest: a marked form records once on submit, and an unmarked button click inside it records nothing')
  setPage(
    '<form id="f" data-fsl-action="checkout_submitted"><input id="i"><button id="plain" type="button">Help</button><button id="go" type="submit">Pay</button></form>',
  )
  el('plain').click()
  assert('a click on the plain button records nothing', crumbs().length === 0, names().join(','))
  el<HTMLFormElement>('f').requestSubmit()
  assert('requestSubmit records the form once', names().join(',') === 'action:checkout_submitted', names().join(','))
  clearBreadcrumbs()
  el('go').click()
  assert('clicking the submit button records the form once, not the click as well', names().join(',') === 'action:checkout_submitted', names().join(','))
}

function testClickInsideMarkedFormIsNotTheFormsAction() {
  console.log('\nTest: a click inside a marked form is not the form\'s action')
  setPage('<form id="f" data-fsl-action="checkout_submitted"><span id="label">Name</span></form>')
  el('label').click()
  assert('nothing recorded', crumbs().length === 0, names().join(','))
}

function testMarkInsideAnOpenShadowRootIsFound() {
  console.log('\nTest: a mark inside an open shadow root is found, and one inside a closed root is not')
  setPage('<div id="host"></div><div id="closedHost"></div>')
  const open = el('host').attachShadow({ mode: 'open' })
  open.innerHTML = '<button data-fsl-action="shadow_apply"><span id="inner">Apply</span></button>'
  el('inner', open).click()
  assert('the open-root mark is recorded', names().join(',') === 'action:shadow_apply', names().join(','))

  clearBreadcrumbs()
  const closed = el('closedHost').attachShadow({ mode: 'closed' })
  closed.innerHTML = '<button data-fsl-action="closed_apply"><span id="inner2">Apply</span></button>'
  closed.querySelector<HTMLElement>('#inner2')?.click()
  assert('the closed-root mark stays closed', crumbs().length === 0, names().join(','))
}

function testStopPropagationDoesNotHideTheAction() {
  console.log('\nTest: an app handler that calls stopPropagation does not stop the crumb')
  setPage('<button id="b" data-fsl-action="apply_discount">Apply</button>')
  let appHandlerRan = false
  el('b').addEventListener('click', (event) => {
    event.stopPropagation()
    appHandlerRan = true
  })
  el('b').click()
  assert('the app handler ran', appHandlerRan)
  assert('the crumb was recorded', names().join(',') === 'action:apply_discount', names().join(','))
}

async function testThrowingHandlerErrorEndsWithTheAction() {
  console.log('\nTest: an error thrown by the app handler carries the action as its last breadcrumb')
  setupGlobalErrorHandler()
  configureRateLimiter({ burstLimit: 50, duplicateLimit: 3 })
  resetRateLimiter()
  setPage('<button id="b" data-fsl-action="apply_discount">Apply</button>')
  el('b').addEventListener('click', () => {
    throw new Error('handler blew up')
  })
  el('b').click()
  await flush()
  const payload = sent.find((p) => p.message === 'handler blew up')
  assert('the thrown error was logged', payload !== undefined, JSON.stringify(sent.map((p) => p.message)))
  const trail = payload?.jsonPayload?.breadcrumbs ?? []
  const last = trail[trail.length - 1]
  assert('its breadcrumbs end with the action', last?.type === 'action' && last?.name === 'apply_discount', JSON.stringify(trail))
}

function testUnmarkedEmptyAndContentNeverReachACrumb() {
  console.log('\nTest: an unmarked click, an empty attribute, and the element\'s text or value never reach a crumb')
  setPage(
    '<button id="plain">Pay $42.10 to Jane Smith</button>' +
      '<button id="empty" data-fsl-action="">Empty</button>' +
      '<button id="blank" data-fsl-action="   ">Blank</button>' +
      '<button id="bare" data-fsl-action>Bare</button>' +
      '<div data-fsl-action="outer"><button id="emptyInner" data-fsl-action="">Inner</button></div>',
  )
  el('plain').click()
  el('empty').click()
  el('blank').click()
  el('bare').click()
  el('emptyInner').click()
  assert('none of them recorded anything', crumbs().length === 0, names().join(','))

  setPage(
    '<button id="pay" data-fsl-action="  pay_clicked  " data-user="jane@example.com" title="Pay $42.10 to Jane Smith">Pay $42.10 to Jane Smith</button>' +
      '<input id="email" data-fsl-action="email_edited" data-note="secret-attr">',
  )
  el<HTMLInputElement>('email').value = 'jane@example.com'
  el('pay').click()
  change(el('email'))
  assert('names are trimmed and nothing else is read', names().join(',') === 'action:pay_clicked,action:email_edited', names().join(','))
  const serialised = JSON.stringify(crumbs())
  for (const secret of ['Jane', '42.10', 'jane@example.com', 'secret-attr']) {
    assert(`"${secret}" is not in any crumb`, !serialised.includes(secret), serialised)
  }
  assert('no crumb has data', crumbs().every((c) => c.data === undefined), serialised)
}

function testCallingEnableActionsTwiceRecordsOnePerAction() {
  console.log('\nTest: calling enableActions() twice records one crumb per action')
  enableActions()
  enableActions()
  setPage(
    '<button id="b" data-fsl-action="apply_discount">Apply</button><select id="s" data-fsl-action="choose_shipping"></select><form id="f" data-fsl-action="checkout_submitted"></form>',
  )
  el('b').click()
  change(el('s'))
  el<HTMLFormElement>('f').requestSubmit()
  assert('three actions, three crumbs', names().join(',') === 'action:apply_discount,action:choose_shipping,action:checkout_submitted', names().join(','))
}

async function run() {
  testOutsideABrowserItDoesNothing()
  testClickOnMarkedButton()
  testClickInsideMarkedButtonRecordsTheButton()
  testNearestMarkWins()
  testEnterOnMarkedButton()
  testSelectRecordsOnChangeNotOnClick()
  testInputAndTextareaRecordOnChange()
  testCheckboxRecordsOnceBecauseTheBrowserChangesItOnClick()
  testChangeOnAnUnmarkedButtonMarkRecordsNothing()
  testFormRecordsOnceOnSubmit()
  testClickInsideMarkedFormIsNotTheFormsAction()
  testMarkInsideAnOpenShadowRootIsFound()
  testStopPropagationDoesNotHideTheAction()
  await testThrowingHandlerErrorEndsWithTheAction()
  testUnmarkedEmptyAndContentNeverReachACrumb()
  testCallingEnableActionsTwiceRecordsOnePerAction()
  reportResults()
}

run()
