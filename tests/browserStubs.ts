/**
 * Real browser globals for the client suites, backed by jsdom.
 *
 * IMPORT THIS FIRST, before any module under test. `rateLimiter` reads `window`
 * at module load to register its `beforeunload` listener, and `client/logger`
 * reads `navigator` at module load to resolve the platform and browser labels —
 * a stub installed later is too late.
 *
 * This used to hand-roll `sessionStorage`, `window` and `navigator`. That
 * started testing the stub rather than the browser: the fake `error` dispatch
 * passed a plain `{ error }` object, so `event.error === null` — what a real
 * browser sends for a cross-origin script error — was unreachable by
 * construction, and the bug in #13 was invisible. jsdom supplies the real
 * event classes, so those cases are now expressible.
 */

import { JSDOM } from 'jsdom'

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.com/checkout',
  userAgent: DEFAULT_UA,
  pretendToBeVisual: true,
})

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
] as const) {
  globals[key] = (win as unknown as Record<string, unknown>)[key]
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
  // jsdom does not expose its listener registry, so count via a probe: a
  // registered `beforeunload` handler is the only thing we assert on today.
  return registeredTypes.get(type) ?? 0
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
