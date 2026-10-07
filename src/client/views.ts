import { setViewReader } from './breadcrumbs'

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

/** Does nothing outside a browser. Calling it again changes nothing. */
export function enableViews(): void {
  if (typeof document === 'undefined') return
  setViewReader(readViews)
}
