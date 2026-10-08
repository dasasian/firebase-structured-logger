import * as fs from 'fs'
import * as path from 'path'
import { makeSelfIgnoringFolder } from '../../shared/ignoredFolder.js'
import { BASE_LABEL_KEYS } from '../../shared/types.js'
import type { LogEntry } from './entry.js'
import { LOCAL_LOG_DIR } from './entry.js'

export const SCHEMA_ENTRY_LIMIT = 500
export const SCHEMA_WINDOW = '7d'
const SCHEMA_CACHE_MILLISECONDS = 24 * 60 * 60 * 1000
const MAX_SAMPLES = 3
const MAX_SAMPLE_LENGTH = 40
const PRIVATE_KEY_PARTS = ['email', 'name', 'phone']

export type SchemaSource = 'cloud' | 'local'

export interface LabelFromLogs {
  count: number
  samples: string[]
}

export interface SchemaFromLogs {
  readAt: string
  source: SchemaSource
  entriesRead: number
  labels: Record<string, LabelFromLogs>
}

export interface LabelFromCode {
  meaning?: string
}

export interface SchemaCache {
  fromLogs?: SchemaFromLogs
  fromCode: Record<string, LabelFromCode>
}

export function schemaCachePath(cwd: string): string {
  return path.join(cwd, LOCAL_LOG_DIR, 'schema.json')
}

export function readSchemaCache(cwd: string): SchemaCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(schemaCachePath(cwd), 'utf-8')) as Partial<SchemaCache>
    return { fromLogs: parsed.fromLogs, fromCode: parsed.fromCode ?? {} }
  } catch {
    return { fromCode: {} }
  }
}

export function writeSchemaCache(cwd: string, cache: SchemaCache): void {
  makeSelfIgnoringFolder(path.dirname(schemaCachePath(cwd)))
  fs.writeFileSync(schemaCachePath(cwd), JSON.stringify(cache, null, 2) + '\n')
}

export function hasNoSamples(labelKey: string): boolean {
  if (labelKey === 'userId') return true
  if ((BASE_LABEL_KEYS as readonly string[]).includes(labelKey)) return false
  const lowered = labelKey.toLowerCase()
  return PRIVATE_KEY_PARTS.some((part) => lowered.includes(part))
}

export function isFresh(fromLogs: SchemaFromLogs | undefined, source: SchemaSource, now: Date): boolean {
  if (!fromLogs || fromLogs.source !== source) return false
  return now.getTime() - new Date(fromLogs.readAt).getTime() < SCHEMA_CACHE_MILLISECONDS
}

/** Counts every label key in `entries` and keeps up to three sample values per key, none for `userId` or for app keys that name a person. */
export function schemaFromEntries(entries: LogEntry[], source: SchemaSource, now: Date): SchemaFromLogs {
  const labels: Record<string, LabelFromLogs> = {}
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry.labels)) {
      const label = (labels[key] ??= { count: 0, samples: [] })
      label.count++
      const sample = String(value).slice(0, MAX_SAMPLE_LENGTH)
      if (!hasNoSamples(key) && label.samples.length < MAX_SAMPLES && !label.samples.includes(sample)) label.samples.push(sample)
    }
  }
  return { readAt: now.toISOString(), source, entriesRead: entries.length, labels }
}

export function formatSchema(cache: SchemaCache): string[] {
  const lines: string[] = []
  for (const [key, label] of Object.entries(cache.fromLogs?.labels ?? {})) {
    const samples = label.samples.length > 0 ? `  samples: ${label.samples.join(' | ')}` : ''
    lines.push(`labels.${key}  [logs]  count: ${label.count}${samples}`)
  }
  for (const [key, label] of Object.entries(cache.fromCode)) {
    lines.push(`labels.${key}  [code]${label.meaning ? `  ${label.meaning}` : ''}`)
  }
  return lines
}
