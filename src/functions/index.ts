import { getLogger } from './requestLogger'
import type { LogWriter } from './logger'

export { initLogger } from './logger'
export type { LogWriter } from './logger'
export { withLogging, getLogger } from './requestLogger'
export { configureAttachments } from './sourceMapCache'
export { createClientLogHandler, createClientLogFunction, ClientLogError } from './logHandler'
export { createHttpLogHandler } from './httpHandler'
export type { ClientLogHandlerConfig, ClientLogRequest } from './logHandler'
export type { HttpLogHandlerConfig, HttpLogRequest, HttpLogResponse } from './httpHandler'
export type { LogSeverity, LogPayload, BaseLabels } from '../shared/types'

export const logError = (...args: Parameters<LogWriter['error']>): void => getLogger().error(...args)
export const logWarn = (...args: Parameters<LogWriter['warning']>): void => getLogger().warning(...args)
export const logInfo = (...args: Parameters<LogWriter['info']>): void => getLogger().info(...args)
export const logDebug = (...args: Parameters<LogWriter['debug']>): void => getLogger().debug(...args)
