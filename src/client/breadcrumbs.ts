import type { BreadcrumbEntry } from '../shared/types'

const MAX_BREADCRUMBS = 50
const MAX_AGE_MS = 5 * 60 * 1000 // 5 minutes

let currentScreen: string | undefined
let activeActivity: string | undefined
let breadcrumbs: BreadcrumbEntry[] = []

export function setCurrentScreen(screen: string): void {
  currentScreen = screen
  addBreadcrumb('nav', `navigate_${screen}`)
}

export function setActiveActivity(activity: string | undefined): void {
  activeActivity = activity
}

export function getCurrentScreen(): string | undefined {
  return currentScreen
}

export function getActiveActivity(): string | undefined {
  return activeActivity
}

export function addBreadcrumb(
  type: BreadcrumbEntry['type'],
  name: string,
  data?: Record<string, unknown>,
): void {
  const now = Date.now()
  const entry: BreadcrumbEntry = { timestamp: now, type, name, data }
  breadcrumbs.push(entry)

  // Entries are appended in timestamp order, so only rebuild the array when the
  // oldest one has actually aged out — otherwise there is nothing to drop.
  const cutoff = now - MAX_AGE_MS
  if (breadcrumbs[0].timestamp <= cutoff) {
    breadcrumbs = breadcrumbs.filter((bc) => bc.timestamp > cutoff)
  }

  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs = breadcrumbs.slice(breadcrumbs.length - MAX_BREADCRUMBS)
  }
}

export function getLastBreadcrumbs(count: number): BreadcrumbEntry[] {
  return breadcrumbs.slice(Math.max(0, breadcrumbs.length - count))
}

export function clearBreadcrumbs(): void {
  breadcrumbs = []
  currentScreen = undefined
  activeActivity = undefined
}

export const bc = {
  action: (name: string, data?: Record<string, unknown>) => addBreadcrumb('action', name, data),
  state:  (name: string, data?: Record<string, unknown>) => addBreadcrumb('state', name, data),
  nav:    (screen: string) => setCurrentScreen(screen),
  error:  (type: string, data?: Record<string, unknown>) => addBreadcrumb('error', type, data),
}
