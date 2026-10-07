import { setAdapterActive } from '../navigation'
import type { NavigationLabels } from '../../shared/types'

type Stop = () => void

/**
 * The one router adapter running at a time, across Vue Router and React Router —
 * a second adapter call stops whichever one is active, the way `enableNavigation()`
 * replaces its own options rather than stacking (CLAUDE.md, module-scoped state).
 */
let activeStop: Stop | undefined

/**
 * Registers a new adapter as the one in force. The previous adapter's own `stop` runs
 * after `activeStop` already points at the new one, so its call back into
 * `clearAdapterStop` — guarded by identity — is a no-op rather than undoing this call.
 */
export function registerAdapterStop(stop: Stop): void {
  const previous = activeStop
  activeStop = stop
  setAdapterActive(true)
  previous?.()
}

/** Called by an adapter's own `stop()`. Only clears state it still owns. */
export function clearAdapterStop(stop: Stop): void {
  if (activeStop !== stop) return
  activeStop = undefined
  setAdapterActive(false)
}

/**
 * Wraps a router adapter's `adjust` option: its answer is used as returned, and a
 * throwing `adjust` falls back to the router's own labels with one console warning
 * — however many times it throws for this adapter instance.
 */
export function createAdjuster(
  adjust: ((labels: NavigationLabels) => NavigationLabels) | undefined,
): (labels: NavigationLabels) => NavigationLabels {
  let warned = false
  return (labels: NavigationLabels): NavigationLabels => {
    if (!adjust) return labels
    try {
      return adjust(labels)
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn('[fsl] adjust threw — using the router\'s own labels for this page:', err instanceof Error ? err.message : err)
      }
      return labels
    }
  }
}
