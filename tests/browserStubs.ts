/**
 * Minimal browser globals for the client-side suites.
 *
 * IMPORT THIS FIRST, before any module under test. `rateLimiter.ts` reads
 * `window` at module load to register its `beforeunload` listener, and
 * `client/logger.ts` reads `navigator` at module load to resolve the platform
 * and browser labels — ESM evaluates imports in order, so a stub installed
 * later is too late.
 */

type Listener = (event: unknown) => void

class MemoryStorage {
  private entries = new Map<string, string>()

  /** Set to true to make every operation throw, as a full/blocked store does. */
  failing = false

  getItem(key: string): string | null {
    if (this.failing) throw new Error('sessionStorage unavailable')
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failing) throw new Error('sessionStorage unavailable')
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    if (this.failing) throw new Error('sessionStorage unavailable')
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  /** Test-only: read the raw stored string without going through the logger. */
  peek(key: string): string | null {
    return this.entries.get(key) ?? null
  }
}

const listeners = new Map<string, Listener[]>()

const windowStub = {
  addEventListener(type: string, listener: Listener): void {
    const existing = listeners.get(type) ?? []
    existing.push(listener)
    listeners.set(type, existing)
  },
  removeEventListener(type: string, listener: Listener): void {
    listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== listener))
  },
}

export const sessionStorageStub = new MemoryStorage()

/** How many listeners are registered for an event type. */
export function listenerCount(type: string): number {
  return (listeners.get(type) ?? []).length
}

/** Invoke every listener registered for an event type. */
export function dispatchWindowEvent(type: string, event: unknown): void {
  for (const listener of listeners.get(type) ?? []) listener(event)
}

const globals = globalThis as Record<string, unknown>
globals.sessionStorage = sessionStorageStub
globals.window = windowStub
globals.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' }

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
