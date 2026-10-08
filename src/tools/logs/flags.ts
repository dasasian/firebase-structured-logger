import { ENTRY_FIELDS, parseAggregate, type Condition, type OrderBy, type Operator, type Query } from './query.js'

export class UsageError extends Error {}

type FlagKind = 'value' | 'many' | 'switch' | 'optionalValue'

type FlagSpec = Record<string, FlagKind>

export const QUERY_FLAGS: FlagSpec = {
  where: 'many',
  select: 'optionalValue',
  'group-by': 'value',
  'order-by': 'value',
  limit: 'value',
  distinct: 'value',
  since: 'value',
  local: 'switch',
  project: 'value',
  repeats: 'value',
}

export const SCHEMA_FLAGS: FlagSpec = {
  refresh: 'switch',
  add: 'many',
  remove: 'many',
  json: 'switch',
  local: 'switch',
  project: 'value',
}

export const ATTACHMENT_FLAGS: FlagSpec = {
  bucket: 'value',
  project: 'value',
}

export interface ParsedFlags {
  values: Record<string, string[]>
  switches: Set<string>
  positionals: string[]
  presentWithoutValue: Set<string>
}

export interface LabelAddition {
  name: string
  meaning?: string
}

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000
export const DEFAULT_SINCE = '1h'

const EXAMPLE = 'fsl logs --where severity=ERROR --since 2h --select timestamp,message --limit 20'

function flagList(spec: FlagSpec): string {
  return Object.keys(spec).map((name) => `--${name}`).join(', ')
}

function looksLikeFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith('--')
}

/** Splits `argv` into flags and positionals. A flag outside `spec` is a `UsageError` that lists the valid ones and shows one example. */
export function parseFlags(argv: string[], spec: FlagSpec): ParsedFlags {
  const parsed: ParsedFlags = { values: {}, switches: new Set(), positionals: [], presentWithoutValue: new Set() }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!looksLikeFlag(token)) {
      parsed.positionals.push(token)
      continue
    }
    const [rawName, inlineValue] = splitInline(token.slice(2))
    const kind = spec[rawName]
    if (kind === undefined) {
      throw new UsageError(`Unknown flag --${rawName}.\nValid flags: ${flagList(spec)}\nExample: ${EXAMPLE}`)
    }
    if (kind === 'switch') {
      parsed.switches.add(rawName)
      continue
    }
    const nextToken = argv[index + 1]
    const takesNext = inlineValue === undefined && nextToken !== undefined && !looksLikeFlag(nextToken)
    const value = inlineValue ?? (takesNext ? nextToken : undefined)
    if (takesNext) index++
    if (value === undefined) {
      if (kind !== 'optionalValue') throw new UsageError(`--${rawName} needs a value.\nExample: ${EXAMPLE}`)
      parsed.presentWithoutValue.add(rawName)
      continue
    }
    parsed.values[rawName] = [...(parsed.values[rawName] ?? []), value]
  }
  return parsed
}

function splitInline(flag: string): [string, string | undefined] {
  const equals = flag.indexOf('=')
  return equals === -1 ? [flag, undefined] : [flag.slice(0, equals), flag.slice(equals + 1)]
}

/** `--add name [meaning]`: the name is the first word after the flag, the meaning an optional second one. */
export function parseLabelAdditions(argv: string[]): { additions: LabelAddition[]; rest: string[] } {
  const additions: LabelAddition[] = []
  const rest: string[] = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--add') {
      rest.push(argv[index])
      continue
    }
    const name = argv[index + 1]
    if (name === undefined || looksLikeFlag(name)) throw new UsageError('--add needs a label name.\nExample: fsl logs schema --add venueId "the venue the order belongs to"')
    index++
    const meaning = argv[index + 1]
    if (meaning !== undefined && !looksLikeFlag(meaning)) {
      additions.push({ name, meaning })
      index++
    } else {
      additions.push({ name })
    }
  }
  return { additions, rest }
}

const OPERATORS: Operator[] = ['>=', '<=', '!=', '=', '~']

export function parseCondition(text: string): Condition {
  let best: { index: number; operator: Operator } | undefined
  for (const operator of OPERATORS) {
    const index = text.indexOf(operator)
    if (index > 0 && (best === undefined || index < best.index)) best = { index, operator }
  }
  if (!best) throw new UsageError(`--where "${text}" has no operator. Use field=value, !=, >=, <= or ~ (contains).\nExample: --where labels.screen=Checkout`)
  return {
    field: text.slice(0, best.index).trim(),
    operator: best.operator,
    value: text.slice(best.index + best.operator.length).trim(),
  }
}

function parseOrderBy(text: string): OrderBy[] {
  return text.split(',').map((part) => {
    const [field, direction = 'asc'] = part.trim().split(/\s+/)
    if (direction !== 'asc' && direction !== 'desc') throw new UsageError(`--order-by "${part}": the direction is asc or desc.\nExample: --order-by "count desc"`)
    return { field, direction }
  })
}

function parseLimit(text: string | undefined): number {
  if (text === undefined) return DEFAULT_LIMIT
  const limit = Number(text)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new UsageError(`--limit is a whole number from 1 to ${MAX_LIMIT}; got "${text}".`)
  return limit
}

function splitList(text: string | undefined): string[] {
  return text === undefined ? [] : text.split(',').map((item) => item.trim()).filter(Boolean)
}

const DEFAULT_ORDER: OrderBy[] = [{ field: 'timestamp', direction: 'asc' }]

export function buildQuery(flags: ParsedFlags): Query {
  const groupBy = splitList(flags.values['group-by']?.[0])
  const select = splitList(flags.values.select?.[0])
  const aggregating = groupBy.length > 0 || select.some((item) => parseAggregate(item) !== undefined)
  return {
    where: (flags.values.where ?? []).map(parseCondition),
    select,
    groupBy,
    orderBy: flags.values['order-by'] ? parseOrderBy(flags.values['order-by'][0]) : aggregating ? [] : DEFAULT_ORDER,
    distinct: flags.values.distinct?.[0],
    limit: parseLimit(flags.values.limit?.[0]),
  }
}

const DURATION_PATTERN = /^(\d+)([mhd])$/
const UNIT_MILLISECONDS = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** `30m`, `2h`, `7d` counted back from `now`, or an ISO time as given. */
export function parseSince(text: string, now: Date): Date {
  const duration = DURATION_PATTERN.exec(text)
  if (duration) return new Date(now.getTime() - Number(duration[1]) * UNIT_MILLISECONDS[duration[2] as 'm' | 'h' | 'd'])
  const instant = new Date(text)
  if (Number.isNaN(instant.getTime())) throw new UsageError(`--since "${text}" is not 30m, 2h, 7d or an ISO time.\nExample: --since 2h`)
  return instant
}

export function fieldListText(knownLabelKeys: string[]): string {
  const labels = knownLabelKeys.map((key) => `labels.${key}`).join(', ')
  return [
    `Entry fields: ${ENTRY_FIELDS.join(', ')}`,
    `Labels: ${labels || '(none known yet)'}`,
    'Payload: jsonPayload.<path>, e.g. jsonPayload.error.message',
    'Aggregates, with --group-by or alone: count, min(field), max(field)',
  ].join('\n')
}
