import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { warnDeprecated } from '../shared/deprecate.js'

export const KEY_FILE_VARIABLE = 'GOOGLE_APPLICATION_CREDENTIALS'
export const DEPRECATED_KEY_FILE_VARIABLE = 'FIREBASE_SERVICE_ACCOUNT_PATH'

export class KeyFileError extends Error {}

export interface KeyFile {
  path: string
  variable: string
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function expandLeadingHome(named: string): string {
  if (named === '~') return os.homedir()
  return named.startsWith('~/') ? path.join(os.homedir(), named.slice(2)) : named
}

/**
 * The key file the tools sign in with, or `undefined` when none is named. The deprecated
 * name wins when both are set and warns once. A named path that is not a file throws a
 * `KeyFileError`, so no tool falls back to another login. A leading `~/` (or a bare `~`) is the
 * home folder, as in a shell; a `~` anywhere else, and `~name`, are left as written. Other
 * relative paths resolve against `cwd`.
 */
export function resolveKeyFile(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): KeyFile | undefined {
  const deprecated = nonEmpty(env[DEPRECATED_KEY_FILE_VARIABLE])
  if (deprecated !== undefined) warnDeprecated(DEPRECATED_KEY_FILE_VARIABLE, KEY_FILE_VARIABLE)
  const variable = deprecated !== undefined ? DEPRECATED_KEY_FILE_VARIABLE : KEY_FILE_VARIABLE
  const named = deprecated ?? nonEmpty(env[KEY_FILE_VARIABLE])
  if (named === undefined) return undefined
  const resolved = path.resolve(cwd, expandLeadingHome(named))
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new KeyFileError(`${variable} names ${resolved}, which is not a file. Nothing was sent. Fix the path, or unset ${variable} to sign in without a key file.`)
  }
  return { path: resolved, variable }
}
