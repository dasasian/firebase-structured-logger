import { execFile } from 'child_process'
import { promisify } from 'util'
import type { CloudLoggingEntry } from './entry.js'

const execFileAsync = promisify(execFile)

const MAX_GCLOUD_OUTPUT_BYTES = 512 * 1024 * 1024

export class GcloudError extends Error {}

export const GCLOUD_MISSING_MESSAGE =
  'gcloud is not installed or not on PATH. Install the Google Cloud CLI (https://cloud.google.com/sdk/docs/install), ' +
  'then sign in with `gcloud auth login` and `gcloud auth application-default login`.'

export type GcloudRunner = (args: string[]) => Promise<string>

/** Runs `gcloud` and returns its stdout. The only place `fsl logs` starts a process. */
export const runGcloud: GcloudRunner = async (args) => {
  try {
    const { stdout } = await execFileAsync('gcloud', args, { maxBuffer: MAX_GCLOUD_OUTPUT_BYTES })
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
}

export type CloudEntryReader = (request: CloudReadRequest) => Promise<CloudLoggingEntry[]>

/**
 * Reads entries newest first through `gcloud logging read --format json`, which prints
 * one JSON array of Cloud Logging `LogEntry` objects. This is the one function a
 * `@google-cloud/logging` client could replace without touching a flag.
 */
export function readCloudEntriesWith(run: GcloudRunner): CloudEntryReader {
  return async ({ projectId, filter, limit }) => {
    const output = await run(['logging', 'read', filter, '--project', projectId, '--format', 'json', '--limit', String(limit), '--order', 'desc'])
    const parsed: unknown = output.trim() === '' ? [] : JSON.parse(output)
    if (!Array.isArray(parsed)) throw new GcloudError('gcloud logging read did not print a JSON array.')
    return parsed as CloudLoggingEntry[]
  }
}

export const readCloudEntries: CloudEntryReader = readCloudEntriesWith(runGcloud)
