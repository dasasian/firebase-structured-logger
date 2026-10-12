import { execFile } from 'child_process'
import { promisify } from 'util'
import { KEY_FILE_VARIABLE, type KeyFile } from '../keyFile.js'
import type { CloudLoggingEntry } from './entry.js'

const execFileAsync = promisify(execFile)

const MAX_GCLOUD_OUTPUT_BYTES = 512 * 1024 * 1024

export class GcloudError extends Error {}

export const GCLOUD_MISSING_MESSAGE =
  'gcloud is not installed or not on PATH. Install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install), ' +
  `then sign in with \`gcloud auth login\`, or name a service-account key file in ${KEY_FILE_VARIABLE}.`

export type ChildEnvironment = Record<string, string>

/** Runs `gcloud` with `args`. `childEnvironment` is added to that process's environment only. */
export type GcloudRunner = (args: string[], childEnvironment?: ChildEnvironment) => Promise<string>

/** What `gcloud` needs, in its own process only, to sign in with `keyFile` and not with the person's login. */
export function signInEnvironment(keyFile: KeyFile | undefined): ChildEnvironment | undefined {
  return keyFile === undefined ? undefined : { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: keyFile.path }
}

const PERMISSION_FAILURES = ['PERMISSION_DENIED', 'HTTPError 403', 'does not have permission', 'does not have storage.']
const SIGN_IN_FAILURES = [
  'Reauthentication failed',
  'There was a problem reauthenticating',
  'active account selected',
  'does not have any valid credentials',
]

function mentionsAny(message: string, parts: string[]): boolean {
  return parts.some((part) => message.includes(part))
}

/** `message` with what a person can do about it, when gcloud refused for permission under a key file or failed to sign in without one. gcloud's own text stays. */
export function explainGcloudFailure(message: string, keyFile: KeyFile | undefined, roleNeeded: string): string {
  if (keyFile !== undefined && mentionsAny(message, PERMISSION_FAILURES)) {
    return `${message}\nfsl signed in with the key file named by ${keyFile.variable}. That service account needs ${roleNeeded}.`
  }
  if (keyFile === undefined && mentionsAny(message, SIGN_IN_FAILURES)) {
    return `${message}\nTo sign in without your own gcloud login, name a service-account key file: set ${KEY_FILE_VARIABLE} to its path (a .env.local is loaded).`
  }
  return message
}

/** Runs `gcloud` and returns its stdout. The only place `fsl logs` starts a process. */
export const runGcloud: GcloudRunner = async (args, childEnvironment) => {
  try {
    const { stdout } = await execFileAsync('gcloud', args, {
      maxBuffer: MAX_GCLOUD_OUTPUT_BYTES,
      env: { ...process.env, ...childEnvironment },
    })
    return stdout
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT') throw new GcloudError(GCLOUD_MISSING_MESSAGE)
    throw new GcloudError(`gcloud failed: ${(failure.stderr ?? failure.message).trim()}`)
  }
}

export interface CloudReadRequest {
  projectId: string
  filter: string
  limit: number
  childEnvironment?: ChildEnvironment
}

export type CloudEntryReader = (request: CloudReadRequest) => Promise<CloudLoggingEntry[]>

/**
 * Reads entries newest first through `gcloud logging read --format json`, which prints
 * one JSON array of Cloud Logging `LogEntry` objects. This is the one function a
 * `@google-cloud/logging` client could replace without touching a flag.
 */
export function readCloudEntriesWith(run: GcloudRunner): CloudEntryReader {
  return async ({ projectId, filter, limit, childEnvironment }) => {
    const output = await run(['logging', 'read', filter, '--project', projectId, '--format', 'json', '--limit', String(limit), '--order', 'desc'], childEnvironment)
    const parsed: unknown = output.trim() === '' ? [] : JSON.parse(output)
    if (!Array.isArray(parsed)) throw new GcloudError('gcloud logging read did not print a JSON array.')
    return parsed as CloudLoggingEntry[]
  }
}

export const readCloudEntries: CloudEntryReader = readCloudEntriesWith(runGcloud)
