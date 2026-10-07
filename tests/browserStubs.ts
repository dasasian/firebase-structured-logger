/**
 * Real browser globals for the client suites, backed by jsdom.
 *
 * IMPORT THIS FIRST, before any module under test. `client/logger` reads
 * `navigator` at module load to resolve the platform and browser labels, and
 * registers its `visibilitychange` listener (repeat-summary flushing) against
 * `document` at load too — a stub installed later is too late for either.
 *
 * This used to hand-roll `sessionStorage`, `window` and `navigator`. That
 * started testing the stub rather than the browser: the fake `error` dispatch
 * passed a plain `{ error }` object, so `event.error === null` — what a real
 * browser sends for a cross-origin script error — was unreachable by
 * construction, and the bug in #13 was invisible. jsdom supplies the real
 * event classes, so those cases are now expressible.
 */

import { JSDOM, type ConstructorOptions } from 'jsdom'

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

// `userAgent` is honoured by jsdom at runtime but missing from its published
// ConstructorOptions type. The cast is the type being wrong, not the call —
// client/logger reads navigator.userAgent at module load and every platform and
// browser label in the suite depends on this value.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.com/checkout',
  userAgent: DEFAULT_UA,
  pretendToBeVisual: true,
} as ConstructorOptions & { userAgent: string })

const win = dom.window
const globals = globalThis as Record<string, unknown>

for (const key of [
  'window',
  'document',
  'navigator',
  'sessionStorage',
  'localStorage',
  'location',
  'history',
  'Blob',
  'File',
  'FileReader',
  'Event',
  'ErrorEvent',
  'PromiseRejectionEvent',
  'CustomEvent',
  'Element',
] as const) {
  globals[key] = (win as unknown as Record<string, unknown>)[key]
}

/**
 * jsdom has no `checkVisibility` and no layout — `getClientRects()` always
 * returns empty regardless of display (verified against jsdom 30). `/client/views`
 * needs both to differ by the same rule, so both stubs read one thing: inline
 * `display`/`visibility`/`opacity` on the element or an ancestor. Installed at
 * import time, before `client/views` or anything that calls `checkVisibility`.
 */
function visibleByInlineStyle(el: Element): boolean {
  let node: Element | null = el
  while (node) {
    const style = (node as HTMLElement).style
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false
    node = node.parentElement
  }
  return true
}

type CheckVisibilityOptions = { opacityProperty?: boolean; visibilityProperty?: boolean }

win.Element.prototype.checkVisibility = function (this: Element, _options?: CheckVisibilityOptions): boolean {
  return visibleByInlineStyle(this)
} as (options?: CheckVisibilityOptions) => boolean

const nonEmptyRects = [{}] as unknown as ReturnType<Element['getClientRects']>
const emptyRects = [] as unknown as ReturnType<Element['getClientRects']>

win.Element.prototype.getClientRects = function (this: Element): ReturnType<Element['getClientRects']> {
  return visibleByInlineStyle(this) ? nonEmptyRects : emptyRects
}

/**
 * Removes the `checkVisibility` stub for one test, so `/client/views` falls
 * through to the `getClientRects` stub above — same rule, different path.
 * Returns a function that restores it.
 */
export function removeCheckVisibilityStub(): () => void {
  const original = win.Element.prototype.checkVisibility
  delete (win.Element.prototype as { checkVisibility?: unknown }).checkVisibility
  return () => {
    win.Element.prototype.checkVisibility = original
  }
}

/**
 * `performance` is deliberately NOT one of the globals copied from jsdom above.
 * jsdom (30.x) implements `performance.now()` but none of the User Timing API —
 * `mark`, `measure`, `getEntriesByType`, `clearMarks`, `clearMeasures` are all
 * absent, and jsdom's own `now()` is itself implemented in terms of the global
 * `performance` — shadowing it with jsdom's copy turns that into infinite
 * recursion. Node's own global `performance` already supports every one of
 * those five (verified against this repo's Node floor), so `client/timing`
 * calls them directly with no feature-detection, and the bare `performance`
 * identifier a client-side suite reads resolves to Node's real one untouched.
 *
 * A fully fake `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`/`Date.now`/
 * `performance.now`, so `client/timing`'s watchdog (a 1 s `setInterval`) and limits
 * are tested with no real waiting. Install around the tests that need it and
 * uninstall after — real timers are restored exactly as they were.
 *
 * `advanceFakeTime` fires every timer whose turn has come, in order, as real time
 * passing would — a 1 s interval advanced by 3000 ms fires three times, on time.
 * `setFakeNow` + `fireDueTimers` is the other case: a laptop sleeping skips ticks
 * outright rather than queuing them, so that pair jumps the clock without firing
 * anything, then fires whatever is due exactly once — the "5 s late" tick the
 * watchdog's own lateness check is for.
 */
interface FakeTimer {
  id: number
  at: number
  interval?: number
  cb: () => void
}

let fakeNow = 0
let fakeTimers: FakeTimer[] = []
let nextFakeTimerId = 1
let realSetTimeout: typeof setTimeout | undefined
let realClearTimeout: typeof clearTimeout | undefined
let realSetInterval: typeof setInterval | undefined
let realClearInterval: typeof clearInterval | undefined
let realDateNow: (() => number) | undefined
let realPerformanceNow: (() => number) | undefined

function scheduleFakeTimer(cb: () => void, ms: number, interval?: number): number {
  const id = nextFakeTimerId++
  fakeTimers.push({ id, at: fakeNow + ms, interval, cb })
  return id
}

function clearFakeTimer(id: number): void {
  fakeTimers = fakeTimers.filter((t) => t.id !== id)
}

export function installFakeClock(start = 0): void {
  fakeNow = start
  fakeTimers = []
  realSetTimeout = globalThis.setTimeout
  realClearTimeout = globalThis.clearTimeout
  realSetInterval = globalThis.setInterval
  realClearInterval = globalThis.clearInterval
  realDateNow = Date.now
  realPerformanceNow = performance.now.bind(performance)

  globalThis.setTimeout = ((cb: () => void, ms = 0) => scheduleFakeTimer(cb, ms)) as unknown as typeof setTimeout
  globalThis.clearTimeout = (id: unknown) => clearFakeTimer(id as number)
  globalThis.setInterval = ((cb: () => void, ms = 0) => scheduleFakeTimer(cb, ms, ms)) as unknown as typeof setInterval
  globalThis.clearInterval = (id: unknown) => clearFakeTimer(id as number)
  win.setTimeout = globalThis.setTimeout as unknown as typeof win.setTimeout
  win.clearTimeout = globalThis.clearTimeout as unknown as typeof win.clearTimeout
  win.setInterval = globalThis.setInterval as unknown as typeof win.setInterval
  win.clearInterval = globalThis.clearInterval as unknown as typeof win.clearInterval
  performance.now = () => fakeNow
  Date.now = () => fakeNow
}

export function uninstallFakeClock(): void {
  if (realSetTimeout) globalThis.setTimeout = realSetTimeout
  if (realClearTimeout) globalThis.clearTimeout = realClearTimeout
  if (realSetInterval) globalThis.setInterval = realSetInterval
  if (realClearInterval) globalThis.clearInterval = realClearInterval
  if (realDateNow) Date.now = realDateNow
  if (realPerformanceNow) performance.now = realPerformanceNow
  win.setTimeout = globalThis.setTimeout as unknown as typeof win.setTimeout
  win.clearTimeout = globalThis.clearTimeout as unknown as typeof win.clearTimeout
  win.setInterval = globalThis.setInterval as unknown as typeof win.setInterval
  win.clearInterval = globalThis.clearInterval as unknown as typeof win.clearInterval
  fakeTimers = []
}

/** Advances the fake clock by `ms`, firing every timer whose turn comes in order. */
export function advanceFakeTime(ms: number): void {
  const target = fakeNow + ms
  for (;;) {
    const due = fakeTimers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    fakeNow = due.at
    if (due.interval !== undefined) due.at = fakeNow + due.interval
    else clearFakeTimer(due.id)
    due.cb()
  }
  fakeNow = target
}

/** Jumps the fake clock forward with no timer firing — a frozen tab or a sleeping laptop. */
export function setFakeNow(ms: number): void {
  fakeNow = ms
}

/** Fires every timer currently due, each exactly once — the single tick a resume gets. */
export function fireDueTimers(): void {
  for (const timer of [...fakeTimers].filter((t) => t.at <= fakeNow).sort((a, b) => a.at - b.at)) {
    if (timer.interval !== undefined) timer.at = fakeNow + timer.interval
    else clearFakeTimer(timer.id)
    timer.cb()
  }
}

export { win as jsdomWindow }

/** Dispatch a real `ErrorEvent`, as the browser does for an uncaught error. */
export function dispatchErrorEvent(init: {
  error?: unknown
  message?: string
  filename?: string
  lineno?: number
  colno?: number
}): void {
  win.dispatchEvent(
    new win.ErrorEvent('error', {
      error: init.error,
      message: init.message ?? '',
      filename: init.filename ?? '',
      lineno: init.lineno ?? 0,
      colno: init.colno ?? 0,
    }),
  )
}

/** Dispatch a real `PromiseRejectionEvent`, as the browser does. */
export function dispatchRejectionEvent(reason: unknown): void {
  // The constructor requires a promise; it is never awaited here.
  const promise = Promise.reject(reason)
  promise.catch(() => {})
  win.dispatchEvent(
    new win.PromiseRejectionEvent('unhandledrejection', { promise, reason }),
  )
}

/** How many listeners the module under test registered for an event type. */
export function listenerCount(type: string): number {
  // jsdom does not expose its listener registry, so count via a probe.
  return registeredTypes.get(type) ?? 0
}

/**
 * Simulate the tab being shown or hidden: sets `document.visibilityState`
 * (a jsdom getter, not a writable property, hence `defineProperty`) and
 * dispatches the real event `client/logger` listens for to flush and send
 * any due repeat summaries.
 */
export function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(win.document, 'visibilityState', { value: state, configurable: true })
  win.document.dispatchEvent(new win.Event('visibilitychange'))
}

const registeredTypes = new Map<string, number>()
const realAddEventListener = win.addEventListener.bind(win)
win.addEventListener = ((type: string, ...rest: unknown[]) => {
  registeredTypes.set(type, (registeredTypes.get(type) ?? 0) + 1)
  return (realAddEventListener as (...a: unknown[]) => void)(type, ...rest)
}) as typeof win.addEventListener
globals.window = win

/**
 * sessionStorage that throws on demand.
 *
 * jsdom will not fail a write on request, but `rateLimiter` has catch blocks
 * for a full or blocked store (Safari private mode throws on write), and those
 * paths need exercising.
 */
class FailableStorage {
  failing = false
  constructor(private readonly inner: Storage) {}
  getItem(key: string): string | null {
    if (this.failing) throw new Error('sessionStorage unavailable')
    return this.inner.getItem(key)
  }
  setItem(key: string, value: string): void {
    if (this.failing) throw new Error('sessionStorage unavailable')
    this.inner.setItem(key, value)
  }
  removeItem(key: string): void {
    if (this.failing) throw new Error('sessionStorage unavailable')
    this.inner.removeItem(key)
  }
  clear(): void {
    this.inner.clear()
  }
  /** Test-only: read the raw stored string, bypassing the failure switch. */
  peek(key: string): string | null {
    return this.inner.getItem(key)
  }
}

export const sessionStorageStub = new FailableStorage(win.sessionStorage)
globals.sessionStorage = sessionStorageStub

/**
 * `localStorage` that throws on demand, same shape as `sessionStorageStub` —
 * pending repeat summaries live here (README, "Summaries survive the tab
 * closing"), and that write path needs the same failure-mode coverage.
 */
export const localStorageStub = new FailableStorage(win.localStorage)
globals.localStorage = localStorageStub

/** Run `fn` with `Date.now()` frozen at `now`, then restore the real clock. */
export function withFrozenTime<T>(now: number, fn: () => T): T {
  const realNow = Date.now
  Date.now = () => now
  try {
    return fn()
  } finally {
    Date.now = realNow
  }
}
