import { addBreadcrumb } from './breadcrumbs'

const ACTION_ATTR = 'data-fsl-action'

type ActionEventType = 'click' | 'submit' | 'change'

const CHANGE_TAGS = new Set(['SELECT', 'INPUT', 'TEXTAREA'])

function eventTypeFor(marked: Element): ActionEventType {
  if (marked.tagName === 'FORM') return 'submit'
  if (CHANGE_TAGS.has(marked.tagName)) return 'change'
  return 'click'
}

function nearestMarked(event: Event): Element | undefined {
  for (const node of event.composedPath()) {
    if (node instanceof Element && node.hasAttribute(ACTION_ATTR)) return node
  }
  return undefined
}

function recordMarkedAction(event: Event): void {
  const marked = nearestMarked(event)
  if (!marked || eventTypeFor(marked) !== event.type) return
  const name = marked.getAttribute(ACTION_ATTR)?.trim()
  if (name) addBreadcrumb('action', name)
}

/** Does nothing outside a browser. Calling it again changes nothing. */
export function enableActions(): void {
  if (typeof document === 'undefined') return
  for (const type of ['click', 'submit', 'change'] as const) {
    document.addEventListener(type, recordMarkedAction, true)
  }
}
