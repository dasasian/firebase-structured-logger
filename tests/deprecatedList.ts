/**
 * The deprecated names of the package, in one list. `deprecatedNames` checks that each carries
 * `@deprecated`; `capabilities` checks that each has a Mistakes line with its replacement.
 *
 * `warnedAs` is the first argument of the `warnDeprecated` call that names the replacement.
 * A name that no run-time warning covers states its `replacement` here instead.
 */

type ReplacementSource = { warnedAs: string } | { replacement: string }

export type DeprecatedDeclaration = { name: string; file: string; declaration: string } & ReplacementSource

export const DEPRECATED_DECLARATIONS: ReadonlyArray<DeprecatedDeclaration> = [
  { name: 'minLogLevel', file: 'src/client/logger.ts', declaration: 'minLogLevel?:', warnedAs: 'minLogLevel' },
  { name: 'bucketName', file: 'src/functions/logHandler.ts', declaration: 'bucketName?: string\n  cors', warnedAs: 'bucketName' },
  { name: 'sessionLimit', file: 'src/client/rateLimiter.ts', declaration: 'sessionLimit?:', warnedAs: 'sessionLimit' },
  { name: 'refillPerMinute', file: 'src/client/rateLimiter.ts', declaration: 'refillPerMinute?:', warnedAs: 'refillPerMinute' },
  { name: 'errorReserve', file: 'src/client/rateLimiter.ts', declaration: 'errorReserve?:', warnedAs: 'errorReserve' },
  { name: 'ClientLogRequest', file: 'src/functions/logHandler.ts', declaration: 'export type ClientLogRequest', replacement: 'LogRequest' },
  { name: 'triggerTestLog', file: 'src/client/logger.ts', declaration: 'export function triggerTestLog', warnedAs: 'triggerTestLog' },
  { name: 'routeFor', file: 'src/client/navigation.ts', declaration: 'routeFor?:', warnedAs: 'routeFor' },
  { name: 'cleanPath', file: 'src/client/navigation.ts', declaration: 'cleanPath?:', warnedAs: 'cleanPath' },
  { name: 'path: false', file: 'src/client/navigation.ts', declaration: 'path?: false', warnedAs: 'path: false' },
  { name: 'routeSource', file: 'src/shared/types.ts', declaration: "routeSource?: 'router'", replacement: 'labelsFor' },
  { name: 'bc.nav', file: 'src/client/breadcrumbs.ts', declaration: 'nav: (screen: string)', warnedAs: 'bc.nav' },
  { name: 'bc.error', file: 'src/client/breadcrumbs.ts', declaration: 'error: (type: string', warnedAs: 'bc.error' },
  { name: 'Logger.setScreen', file: 'src/client/logger.ts', declaration: 'setScreen(screen: string)', warnedAs: 'setScreen' },
]

export const DEPRECATED_CLI_FLAGS: ReadonlyArray<{ name: string; file: string; warnedAs: string }> = [
  { name: '--functions', file: 'src/tools/index.ts', warnedAs: '--functions' },
]
