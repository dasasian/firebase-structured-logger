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
}

export interface BreadcrumbEntry {
  timestamp: number
  type: 'action' | 'state' | 'nav' | 'error'
  name: string
  data?: Record<string, unknown>
}
