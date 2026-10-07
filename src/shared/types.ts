export type LogSeverity = 'ERROR' | 'WARNING' | 'NOTICE' | 'INFO' | 'DEBUG'

export interface BaseLabels {
  appId: string
  userId?: string
  screen?: string
  platform?: string
  browser?: string
  releaseId?: string
  errorType?: string
  errorCategory?: string
  /** The route pattern, e.g. `/orders/:id/items`. Set by `enableNavigation()` or `navigatedTo()`. */
  route?: string
  /** The real path, e.g. `/orders/1042/items`. Set by `enableNavigation()` or `navigatedTo()`. */
  path?: string
  /**
   * Whether `route` came from the deprecated `routeFor` or the id rule.
   * @deprecated Removed in 2.0 — a `labelsFor` answer is final and carries no source.
   */
  routeSource?: 'router' | 'pattern'
}

/**
 * What `enableNavigation()` and `navigatedTo()` (both
 * `@dasasian/firebase-structured-logger/client/navigation`) hand to the core logger for
 * the current page, through `setCurrentRoute` in `client/breadcrumbs.ts`. Used exactly
 * as given — a field left out is not logged — so every field is optional.
 */
export interface NavigationLabels {
  route?: string
  screen?: string
  path?: string
  /** @deprecated Removed in 2.0. Set only by `defaultLabelsFor()` and the deprecated `routeFor`/`cleanPath`/`path: false`. */
  routeSource?: 'router' | 'pattern'
}

export interface ErrorPayload {
  message: string
  stack?: string
  name?: string
  cause?: string
}

export interface LogPayload {
  message: string
  severity: LogSeverity
  labels: BaseLabels & Record<string, string | undefined>
  jsonPayload?: {
    breadcrumbs?: BreadcrumbEntry[]
    context?: Record<string, unknown>
    error?: ErrorPayload
  }
  /** Base64-encoded attachments keyed by name. Uploaded to GCS, stripped before writing to Cloud Logging. */
  attachments?: Record<string, string>
  /**
   * Client-supplied ISO timestamp. Only honoured for a repeat summary
   * (`labels.repeatCount` present), and only within the last 8 days and not
   * more than 5 minutes in the future — see `writeLog`'s production branch.
   * Anything else keeps the server's own time.
   */
  timestamp?: string
}

export interface BreadcrumbEntry {
  timestamp: number
  type: 'action' | 'state' | 'nav' | 'error'
  name: string
  data?: Record<string, unknown>
}
