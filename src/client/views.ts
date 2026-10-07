import { setViewReader } from './breadcrumbs'

/**
 * `@dasasian/firebase-structured-logger/client/views` — its own entry point
 * (CLAUDE.md, "Optional client helpers are separate entry points"), so an app
 * that never imports it ships none of this. See README, "Views: what was on
 * screen", and CLAUDE.md, "Views are read when an entry is written".
 */
const VIEW_ATTR = 'data-fsl-view'

type CheckVisibility = (options?: { opacityProperty?: boolean; visibilityProperty?: boolean }) => boolean

function isVisible(el: Element): boolean {
  const checkVisibility = (el as unknown as { checkVisibility?: CheckVisibility }).checkVisibility
  if (typeof checkVisibility === 'function') {
    return checkVisibility.call(el, { opacityProperty: true, visibilityProperty: true })
  }
  return el.getClientRects().length > 0
}

function readViews(): string | undefined {
  const names: string[] = []
  document.querySelectorAll(`[${VIEW_ATTR}]`).forEach((el) => {
    if (!isVisible(el)) return
    const name = el.getAttribute(VIEW_ATTR)
    if (name) names.push(name)
  })
  return names.length > 0 ? names.join(' › ') : undefined
}

/**
 * Turns on view labelling for the session. Registers `readViews` as the
 * reader `getActiveView()` (`breadcrumbs.ts`) calls when an entry is
 * written — no listeners, no observers, nothing kept in sync. A later call
 * replaces the reader rather than adding a second one. Does nothing outside
 * a browser (Node, SSR).
 */
export function enableViews(): void {
  if (typeof document === 'undefined') return
  setViewReader(readViews)
}
