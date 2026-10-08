import * as path from 'path'
import * as fs from 'fs'
import { downloadAttachments, checkLogId } from './attachments.js'
import { normalizeCloudEntry, readLocalEntries, LOCAL_LOG_DIR, type LogEntry } from './entry.js'
import { buildCloudFilter } from './cloudFilter.js'
import { checkFields, knownLabelKeysFrom, labelKeysIn } from './fields.js'
import {
  ATTACHMENT_FLAGS, DEFAULT_SINCE, MAX_LIMIT, QUERY_FLAGS, SCHEMA_FLAGS, UsageError,
  buildQuery, fieldListText, parseFlags, parseLabelAdditions, parseSince, type ParsedFlags,
} from './flags.js'
import { GcloudError, readCloudEntries, runGcloud, type CloudEntryReader, type GcloudRunner } from './gcloud.js'
import { redact, resolveBucket, resolveProjectId } from './project.js'
import { runQuery, type Query } from './query.js'
import {
  SCHEMA_ENTRY_LIMIT, SCHEMA_WINDOW, formatSchema, isFresh, readSchemaCache, schemaFromEntries, writeSchemaCache,
  type SchemaCache, type SchemaSource,
} from './schema.js'

export const MAX_CLOUD_ENTRIES = 5000
const DEFAULT_REPEATS_SINCE = '7d'

export interface LogsDependencies {
  readCloudEntries: CloudEntryReader
  runGcloud: GcloudRunner
  now: () => Date
  cwd: string
  env: NodeJS.ProcessEnv
  printLine: (line: string) => void
  printErrorLine: (line: string) => void
}

export function defaultLogsDependencies(): LogsDependencies {
  return {
    readCloudEntries,
    runGcloud,
    now: () => new Date(),
    cwd: process.cwd(),
    env: process.env,
    printLine: (line) => process.stdout.write(line + '\n'),
    printErrorLine: (line) => process.stderr.write(line + '\n'),
  }
}

interface Fetched {
  entries: LogEntry[]
  hitScanCap: boolean
}

interface FetchRequest {
  since: Date
  query: Query
  knownLabelKeys: ReadonlySet<string>
  repeatKey?: string
  scanLimit: number
}

async function fetchEntries(flags: ParsedFlags, deps: LogsDependencies, request: FetchRequest): Promise<Fetched> {
  if (flags.switches.has('local')) return fetchLocalEntries(deps, request)
  const projectId = resolveProjectId(flags.values.project?.[0], deps.cwd)
  const filter = buildCloudFilter({ since: request.since, where: request.query.where, knownLabelKeys: request.knownLabelKeys, repeatKey: request.repeatKey })
  try {
    const raw = await deps.readCloudEntries({ projectId, filter, limit: request.scanLimit })
    return { entries: raw.map(normalizeCloudEntry), hitScanCap: raw.length >= request.scanLimit }
  } catch (error) {
    if (error instanceof GcloudError) throw new GcloudError(redact(error.message, [projectId]))
    throw error
  }
}

function fetchLocalEntries(deps: LogsDependencies, request: FetchRequest): Fetched {
  const logDir = path.join(deps.cwd, LOCAL_LOG_DIR)
  if (!fs.existsSync(logDir)) {
    throw new UsageError(`No ${LOCAL_LOG_DIR}/ here. Run from the project root where the emulator writes its logs (initLogger({ logLocalDir })).`)
  }
  const { entries, unreadableLines } = readLocalEntries(logDir)
  if (unreadableLines > 0) deps.printErrorLine(`skipped ${unreadableLines} unreadable line(s) in ${LOCAL_LOG_DIR}/`)
  const inWindow = entries.filter((entry) => entry.timestamp >= request.since.toISOString())
  return { entries: inWindow, hitScanCap: false }
}

function printResult(rows: unknown[], moreRows: number, hitScanCap: boolean, deps: LogsDependencies): void {
  for (const row of rows) deps.printLine(JSON.stringify(row))
  if (moreRows > 0) deps.printErrorLine(`truncated: ${rows.length} shown, ${moreRows} more. Narrow with --where or raise --limit (max ${MAX_LIMIT}).`)
  if (hitScanCap) deps.printErrorLine(`scanned: only the newest ${MAX_CLOUD_ENTRIES} entries in the window were read. Narrow with --since or --where.`)
}

function describeNoMatch(flags: ParsedFlags, query: Query, sinceText: string): string {
  const noun = query.groupBy.length > 0 || query.distinct !== undefined ? 'groups' : 'entries'
  const place = flags.switches.has('local') ? ` in ${LOCAL_LOG_DIR}/*.jsonl` : ''
  const window = /^\d+[mhd]$/.test(sinceText) ? `in the last ${sinceText}` : `since ${sinceText}`
  return `0 ${noun} matched${place} ${window}.`
}

function schemaLabelKeys(cache: SchemaCache): string[] {
  return [...Object.keys(cache.fromLogs?.labels ?? {}), ...Object.keys(cache.fromCode)]
}

async function runQueryCommand(argv: string[], deps: LogsDependencies): Promise<void> {
  const flags = parseFlags(argv, QUERY_FLAGS)
  const cache = readSchemaCache(deps.cwd)
  const knownLabelKeys = knownLabelKeysFrom(schemaLabelKeys(cache))
  if (flags.presentWithoutValue.has('select')) {
    deps.printLine(fieldListText([...knownLabelKeys]))
    return
  }
  const repeatKey = flags.values.repeats?.[0]
  const query = buildQuery(flags)
  const sinceText = flags.values.since?.[0] ?? (repeatKey ? DEFAULT_REPEATS_SINCE : DEFAULT_SINCE)
  const since = parseSince(sinceText, deps.now())
  const fetched = await fetchEntries(flags, deps, { since, query, knownLabelKeys, repeatKey, scanLimit: MAX_CLOUD_ENTRIES })
  const keysInData = labelKeysIn(fetched.entries)
  checkFields(query, knownLabelKeysFrom(knownLabelKeys, keysInData))

  if (repeatKey !== undefined) {
    printRepeats(fetched, query, repeatKey, deps)
    return
  }
  const { rows, moreRows } = runQuery(fetched.entries, query)
  printResult(rows, moreRows, fetched.hitScanCap, deps)
  if (rows.length === 0) deps.printErrorLine(describeNoMatch(flags, query, sinceText))
}

function printRepeats(fetched: Fetched, query: Query, repeatKey: string, deps: LogsDependencies): void {
  const related = fetched.entries.filter((entry) => entry.labels.repeatKey === repeatKey || entry.labels.repeatOf === repeatKey)
  const copies = related.filter((entry) => entry.labels.repeatKey === repeatKey && entry.labels.repeatOf === undefined)
  const summaries = related.filter((entry) => entry.labels.repeatOf === repeatKey)
  const counted = summaries.reduce((total, entry) => total + Number(entry.labels.repeatCount ?? 0), 0)
  const { rows, moreRows } = runQuery(related, query)
  printResult(rows, moreRows, fetched.hitScanCap, deps)
  deps.printLine(JSON.stringify({ repeatKey, trueCount: copies.length + counted, fullCopies: copies.length, summaries: summaries.length, countedInSummaries: counted }))
}

async function runSchemaCommand(argv: string[], deps: LogsDependencies): Promise<void> {
  const { additions, rest } = parseLabelAdditions(argv)
  const flags = parseFlags(rest, SCHEMA_FLAGS)
  const cache = readSchemaCache(deps.cwd)
  for (const { name, meaning } of additions) cache.fromCode[name] = meaning ? { meaning } : {}
  for (const name of flags.values.remove ?? []) delete cache.fromCode[name]
  writeSchemaCache(deps.cwd, cache)

  const source: SchemaSource = flags.switches.has('local') ? 'local' : 'cloud'
  const stale = flags.switches.has('refresh') || !isFresh(cache.fromLogs, source, deps.now())
  if (stale) {
    const query = buildQuery(parseFlags([], QUERY_FLAGS))
    const since = parseSince(SCHEMA_WINDOW, deps.now())
    const fetched = await fetchEntries(flags, deps, { since, query, knownLabelKeys: new Set(), scanLimit: SCHEMA_ENTRY_LIMIT })
    const newest = [...fetched.entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, SCHEMA_ENTRY_LIMIT)
    cache.fromLogs = schemaFromEntries(newest, source, deps.now())
  }
  writeSchemaCache(deps.cwd, cache)
  if (flags.switches.has('json')) deps.printLine(JSON.stringify(cache))
  else for (const line of formatSchema(cache)) deps.printLine(line)
}

async function runAttachmentsCommand(argv: string[], deps: LogsDependencies): Promise<void> {
  const flags = parseFlags(argv, ATTACHMENT_FLAGS)
  const logId = checkLogId(flags.positionals[0])
  const bucket = resolveBucket(flags.values.bucket?.[0], deps.env)
  const { names, folder } = await downloadAttachments(deps.runGcloud, bucket, logId, deps.cwd).catch((error: unknown) => {
    if (error instanceof GcloudError) throw new GcloudError(redact(error.message, [bucket]))
    throw error
  })
  if (names.length === 0) deps.printErrorLine(`No attachments for ${logId}.`)
  for (const name of names) deps.printLine(JSON.stringify({ name, savedTo: path.join(path.relative(deps.cwd, folder), name) }))
}

/** `fsl logs`, `fsl logs schema` and `fsl logs attachments <logId>`. Returns the exit code; every failure is a message on stderr that never contains the project id or bucket. */
export async function runLogs(argv: string[], deps: LogsDependencies = defaultLogsDependencies()): Promise<number> {
  const [subcommand, ...afterSubcommand] = argv
  try {
    if (subcommand === 'schema') await runSchemaCommand(afterSubcommand, deps)
    else if (subcommand === 'attachments') await runAttachmentsCommand(afterSubcommand, deps)
    else await runQueryCommand(argv, deps)
    return 0
  } catch (error) {
    if (error instanceof UsageError || error instanceof GcloudError) {
      deps.printErrorLine(error.message)
      return 1
    }
    throw error
  }
}
