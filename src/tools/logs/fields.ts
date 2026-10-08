import { BASE_LABEL_KEYS } from '../../shared/types.js'
import { UsageError, fieldListText } from './flags.js'
import { ENTRY_FIELDS, parseAggregate, type Query } from './query.js'
import type { LogEntry } from './entry.js'

const LABEL_PREFIX = 'labels.'
const PAYLOAD_PREFIX = 'jsonPayload.'
const SUGGESTION_DISTANCE = 2

export function knownLabelKeysFrom(...sources: Iterable<string>[]): Set<string> {
  return new Set([...BASE_LABEL_KEYS, ...sources.flatMap((source) => [...source])])
}

export function labelKeysIn(entries: LogEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => Object.keys(entry.labels)))
}

function editDistance(first: string, second: string): number {
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  for (let row = 1; row <= first.length; row++) {
    const current = [row]
    for (let column = 1; column <= second.length; column++) {
      const substitution = previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1)
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[second.length]
}

function closestField(field: string, candidates: string[]): string | undefined {
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: editDistance(field.toLowerCase(), candidate.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance)
  return ranked[0] && ranked[0].distance <= SUGGESTION_DISTANCE ? ranked[0].candidate : undefined
}

function isKnownField(field: string, labelKeys: ReadonlySet<string>): boolean {
  if ((ENTRY_FIELDS as readonly string[]).includes(field)) return true
  if (field.startsWith(PAYLOAD_PREFIX)) return field.length > PAYLOAD_PREFIX.length
  return field.startsWith(LABEL_PREFIX) && labelKeys.has(field.slice(LABEL_PREFIX.length))
}

function fieldsUsedBy(query: Query): string[] {
  const outputNames = new Set(query.select)
  const selected = query.select.map((item) => parseAggregate(item)?.field ?? item).filter((field) => field !== '*')
  const ordered = query.orderBy.map((order) => order.field).filter((field) => !outputNames.has(field))
  return [...query.where.map((c) => c.field), ...query.groupBy, ...(query.distinct ? [query.distinct] : []), ...selected, ...ordered]
}

/** Throws a `UsageError` naming the first field that is not an entry field, a known label or a payload path, with the closest valid one. */
export function checkFields(query: Query, labelKeys: ReadonlySet<string>): void {
  const unknown = fieldsUsedBy(query).find((field) => !isKnownField(field, labelKeys))
  if (unknown === undefined) return
  const candidates = [...ENTRY_FIELDS, ...[...labelKeys].map((key) => `${LABEL_PREFIX}${key}`)]
  const suggestion = closestField(unknown, candidates)
  const lines = [`Unknown field "${unknown}".`]
  if (suggestion) lines.push(`Did you mean ${suggestion}?`)
  lines.push(fieldListText([...labelKeys]))
  lines.push('Run `fsl logs schema` to list the labels your logs carry.')
  lines.push('Example: fsl logs --where labels.screen=Checkout --select timestamp,severity,message')
  throw new UsageError(lines.join('\n'))
}
