import * as fs from 'fs'
import * as path from 'path'
import { UsageError } from './flags.js'

interface FirebaseRc {
  projects?: Record<string, string>
}

function projectFromFirebaserc(cwd: string): string | undefined {
  const file = path.join(cwd, '.firebaserc')
  if (!fs.existsSync(file)) return undefined
  try {
    const projects = (JSON.parse(fs.readFileSync(file, 'utf-8')) as FirebaseRc).projects ?? {}
    const names = Object.values(projects)
    return projects.default ?? (names.length === 1 ? names[0] : undefined)
  } catch {
    return undefined
  }
}

/** The Google Cloud project to read: `--project`, else `.firebaserc`. Its value is never printed. */
export function resolveProjectId(flagValue: string | undefined, cwd: string): string {
  const projectId = flagValue ?? projectFromFirebaserc(cwd)
  if (projectId === undefined) {
    throw new UsageError('No project to read. Pass --project <id>, or run from a folder whose .firebaserc names one (or use --local).')
  }
  return projectId
}

/** The bucket holding attachments: `--bucket`, else the storage bucket variable `upload-sourcemaps` also reads. Its value is never printed. */
export function resolveBucket(flagValue: string | undefined, env: NodeJS.ProcessEnv): string {
  const bucket = flagValue ?? env.FIREBASE_STORAGE_BUCKET ?? env.VITE_FIREBASE_STORAGE_BUCKET
  if (bucket === undefined) {
    throw new UsageError('No bucket to read. Pass --bucket <name>, or set FIREBASE_STORAGE_BUCKET (a .env.local is loaded).')
  }
  return bucket
}

/** Replaces every secret in `text`, for messages that quote a command line or a gcloud error. */
export function redact(text: string, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((safe, secret) => safe.split(secret).join('<hidden>'), text)
}
