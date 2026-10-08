import * as fs from 'fs'
import * as path from 'path'
import { ATTACHMENT_PREFIX } from '../../shared/paths.js'
import { LOCAL_LOG_DIR } from './entry.js'
import { UsageError } from './flags.js'
import type { GcloudRunner } from './gcloud.js'

const LOG_ID_PATTERN = /^[A-Za-z0-9]+$/

export function attachmentFolder(cwd: string, logId: string): string {
  return path.join(cwd, LOCAL_LOG_DIR, 'attachments', logId)
}

export function checkLogId(logId: string | undefined): string {
  if (logId === undefined || !LOG_ID_PATTERN.test(logId)) {
    throw new UsageError('fsl logs attachments needs the entry\'s logId (labels.logId).\nExample: fsl logs attachments 01JAXYZ...')
  }
  return logId
}

export interface DownloadedAttachments {
  names: string[]
  folder: string
}

/** Lists `logAttachments/<logId>/` in the bucket and copies it to `.fsl-logs/attachments/<logId>/`, both through `gcloud storage`. */
export async function downloadAttachments(run: GcloudRunner, bucket: string, logId: string, cwd: string): Promise<DownloadedAttachments> {
  const source = `gs://${bucket}/${ATTACHMENT_PREFIX}/${logId}`
  const listing = await run(['storage', 'ls', `${source}/`])
  const names = listing.split('\n').map((line) => line.trim()).filter(Boolean).map((url) => url.slice(url.lastIndexOf('/') + 1))
  const folder = attachmentFolder(cwd, logId)
  fs.mkdirSync(folder, { recursive: true })
  if (names.length > 0) await run(['storage', 'cp', `${source}/*`, folder])
  return { names, folder }
}
