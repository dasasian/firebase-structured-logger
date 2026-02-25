export type LogSeverity = 'ERROR' | 'WARNING' | 'INFO' | 'DEBUG'

export interface BaseLabels {
  appId: string
  userId?: string
  screen?: string
  platform?: string
  browser?: string
  releaseId?: string
  errorType?: string
  errorCategory?: string
  activity?: string
}

export interface LogPayload {
  message: string
  severity: LogSeverity
  labels: BaseLabels & Record<string, string | undefined>
  jsonPayload?: {
    breadcrumbs?: BreadcrumbEntry[]
    context?: Record<string, unknown>
    error?: {
      message: string
      stack?: string
      name?: string
      cause?: string
    }
  }
}

export interface BreadcrumbEntry {
  timestamp: number
  type: 'action' | 'state' | 'nav' | 'error'
  name: string
  data?: Record<string, unknown>
}
