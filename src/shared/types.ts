export type LogSeverity = 'ERROR' | 'WARNING' | 'NOTICE' | 'INFO' | 'DEBUG'

export interface BaseLabels {
  /** The app that wrote the entry, from `initLogger({ appId })`. */
  appId: string
  /** The signed-in user, from `setUser()`. On client entries it is self-reported, not verified. */
  userId?: string
  /** The screen name, from navigation, `navigatedTo()` or the deprecated `setScreen()`. */
  screen?: string
  /** The browser's platform: `ios`, `android`, `macos`, `windows`, `linux`, `web` when none match, or `unknown` outside a browser. Client entries only. */
  platform?: string
  /** The browser family, e.g. `Chrome`. Client entries only. */
  browser?: string
  /** The release the code was built from, from `initLogger({ releaseId })`; the key to its source maps. */
  releaseId?: string
  /** The error's class name, e.g. `TypeError`. Set on error entries. */
  errorType?: string
  /** What kind of failure it was, e.g. `crash`. Set by the global error handlers. */
  errorCategory?: string
  /** The route pattern, e.g. `/orders/:id/items`. Set by `enableNavigation()` or `navigatedTo()`. */
  route?: string
  /** The real path, e.g. `/orders/1042/items`. Set by `enableNavigation()` or `navigatedTo()`. */
  path?: string
  /** The visible marks, joined with ` › `, e.g. `payment › Attachment`. Set by `enableViews()`. */
  view?: string
  /**
   * Whether `route` came from the deprecated `routeFor` or the id rule.
   * @deprecated Removed in 2.0 — a `labelsFor` answer is final and carries no source.
   */
  routeSource?: 'router' | 'pattern'
  /** Ties an error's full copies to the one summary of its repeats. Set on the first copies of a repeating error. */
  repeatKey?: string
  /** On a repeat summary: the `repeatKey` of the error it counts. */
  repeatOf?: string
  /** On a repeat summary: how many more times the error happened after its full copies. */
  repeatCount?: string
  /** On a repeat summary: when the first counted repeat happened, ISO time. */
  firstSeen?: string
  /** On a repeat summary: when the last counted repeat happened, ISO time. */
  lastSeen?: string
  /** `true` on a repeat summary sent by a later visit than the one that counted the repeats. */
  sentLate?: string
  /** `true` when the entry was too large for Cloud Logging and fsl cut it down; the full entry is an attachment. */
  truncated?: string
  /** `true` when files were saved for this entry; read them with `fsl logs attachments <logId>`. */
  hasAttachments?: string
  /** The entry's own id, and the folder name of its attachments. Added by the functions logger. */
  logId?: string
  /** The function that handled the request, on entries written in a request. */
  functionName?: string
  /** The name of the timing trace that ran slow. */
  trace?: string
  /** Ties together the entries of one run of a timing trace. */
  run?: string
  /** What ran slow: the whole `trace`, or one `step`. */
  slow?: 'trace' | 'step'
  /** The name of the slow step, when `slow` is `step`. */
  step?: string
  /** `true` on a report a person sent with `sendFeedback()`. */
  feedback?: string
}

/** Every key of `BaseLabels`, for tools that need the names at run time. */
export const BASE_LABEL_KEYS = [
  'appId', 'userId', 'screen', 'platform', 'browser', 'releaseId', 'errorType', 'errorCategory',
  'route', 'path', 'view', 'routeSource', 'repeatKey', 'repeatOf', 'repeatCount', 'firstSeen',
  'lastSeen', 'sentLate', 'truncated', 'hasAttachments', 'logId', 'functionName', 'trace', 'run',
  'slow', 'step', 'feedback',
] as const satisfies readonly (keyof BaseLabels)[]

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
