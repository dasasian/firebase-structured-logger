/**
 * Support for the `fsl logs` suites: a fake transport and the output it is read through.
 * The fixtures follow the `LogEntry` that `gcloud logging read --format json` prints — one
 * JSON array of Cloud Logging `LogEntry` resources, with fsl's labels promoted to
 * `labels` and the message inside `jsonPayload` — as documented in the Cloud Logging
 * REST reference (`LogEntry`); `gcloud logging read --help` confirms `--format=json`
 * and newest-first order, and nothing in `npm test` calls gcloud.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { runLogs, type LogsDependencies } from '../src/tools/logs/command.js'
import type { CloudLoggingEntry } from '../src/tools/logs/entry.js'
import type { CloudReadRequest } from '../src/tools/logs/gcloud.js'

export const FAKE_PROJECT = 'sentinel-project-7431'
export const FAKE_BUCKET = 'sentinel-bucket-9928'
export const FIXED_NOW = new Date('2026-03-10T12:00:00.000Z')

export interface Run {
  code: number
  stdout: string[]
  stderr: string[]
  cloudRequests: CloudReadRequest[]
  gcloudCalls: string[][]
}

export function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-logs-'))
}

export function withFirebaserc(cwd: string): void {
  fs.writeFileSync(path.join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: FAKE_PROJECT } }))
}

export function cloudEntry(fields: {
  minutesAgo?: number
  severity?: string
  message?: string
  labels?: Record<string, string>
  functionName?: string
  payload?: Record<string, unknown>
}): CloudLoggingEntry {
  const timestamp = new Date(FIXED_NOW.getTime() - (fields.minutesAgo ?? 1) * 60_000).toISOString()
  return {
    insertId: `id-${Math.random().toString(36).slice(2)}`,
    jsonPayload: { message: fields.message ?? 'something happened', ...fields.payload },
    labels: { appId: 'demo-app', ...fields.labels },
    resource: { labels: { function_name: fields.functionName ?? 'handler', project_id: 'ignored' } },
    severity: fields.severity ?? 'INFO',
    timestamp,
    trace: 'projects/ignored/traces/abc',
  }
}

export async function runFsl(
  argv: string[],
  options: { cwd: string; cloud?: CloudLoggingEntry[]; gcloudOutput?: (args: string[]) => string; env?: NodeJS.ProcessEnv },
): Promise<Run> {
  const result: Run = { code: -1, stdout: [], stderr: [], cloudRequests: [], gcloudCalls: [] }
  const deps: LogsDependencies = {
    readCloudEntries: async (request) => {
      result.cloudRequests.push(request)
      return options.cloud ?? []
    },
    runGcloud: async (args) => {
      result.gcloudCalls.push(args)
      return options.gcloudOutput?.(args) ?? ''
    },
    now: () => FIXED_NOW,
    cwd: options.cwd,
    env: options.env ?? {},
    printLine: (line) => result.stdout.push(line),
    printErrorLine: (line) => result.stderr.push(line),
  }
  result.code = await runLogs(argv, deps)
  return result
}
