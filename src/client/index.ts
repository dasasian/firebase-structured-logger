export { initLogger, getClientLogger, triggerTestLog } from './logger'
// Logger is exported as a TYPE only. The client logger is a session singleton:
// breadcrumbs, current screen, active activity and the rate-limit budget all
// live in module scope because they are facts about the session, not about an
// instance. A second `new Logger(...)` would share all of them while looking
// independent. Use initLogger() / getClientLogger(); annotate with Logger<T>.
export type { Logger, InitLoggerConfig, RateLimitConfig } from './logger'
export { setupGlobalErrorHandler, handleReactError } from './errorHandler'
export { addBreadcrumb, setActiveActivity, bc } from './breadcrumbs'
export type { LogSeverity, LogPayload, BreadcrumbEntry, BaseLabels } from '../shared/types'
