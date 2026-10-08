import type { LogEntry } from './entry.js'

export type Operator = '=' | '!=' | '>=' | '<=' | '~'

export interface Condition {
  field: string
  operator: Operator
  value: string
}

export type AggregateOperation = 'count' | 'min' | 'max'

export interface Aggregate {
  operation: AggregateOperation
  field: string
  outputName: string
}

export interface OrderBy {
  field: string
  direction: 'asc' | 'desc'
}

export interface Query {
  where: Condition[]
  select: string[]
  groupBy: string[]
  orderBy: OrderBy[]
  distinct?: string
  limit: number
}

export type Row = Record<string, unknown>

export interface QueryResult {
  rows: Row[]
  moreRows: number
}

export const ENTRY_FIELDS = ['timestamp', 'severity', 'message', 'functionName', 'requestId', 'trace', 'insertId'] as const

const AGGREGATE_PATTERN = /^(min|max)\((.+)\)$/

export function parseAggregate(selectItem: string): Aggregate | undefined {
  if (selectItem === 'count') return { operation: 'count', field: '*', outputName: 'count' }
  const match = AGGREGATE_PATTERN.exec(selectItem)
  if (!match) return undefined
  return { operation: match[1] as AggregateOperation, field: match[2], outputName: selectItem }
}

function valueAtPath(entry: unknown, fieldPath: string): unknown {
  let current: unknown = entry
  for (const part of fieldPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function isNumeric(text: string): boolean {
  return text.trim() !== '' && Number.isFinite(Number(text))
}

function compare(fieldValue: unknown, clauseValue: string): number {
  const fieldText = String(fieldValue)
  if (isNumeric(fieldText) && isNumeric(clauseValue)) return Number(fieldText) - Number(clauseValue)
  return fieldText < clauseValue ? -1 : fieldText > clauseValue ? 1 : 0
}

function equalsClauseValue(field: string, fieldValue: unknown, clauseValue: string): boolean {
  const fieldText = String(fieldValue)
  if (field === 'functionName') return fieldText.toLowerCase() === clauseValue.toLowerCase()
  return fieldText === clauseValue
}

function matches(entry: LogEntry, condition: Condition): boolean {
  const fieldValue = valueAtPath(entry, condition.field)
  const present = fieldValue !== undefined && fieldValue !== null
  switch (condition.operator) {
    case '=':
      return present && equalsClauseValue(condition.field, fieldValue, condition.value)
    case '!=':
      return !present || !equalsClauseValue(condition.field, fieldValue, condition.value)
    case '~':
      return present && String(fieldValue).toLowerCase().includes(condition.value.toLowerCase())
    case '>=':
      return present && compare(fieldValue, condition.value) >= 0
    case '<=':
      return present && compare(fieldValue, condition.value) <= 0
  }
}

function sortableValue(value: unknown): number | string {
  return typeof value === 'number' ? value : String(value)
}

function compareForOrder(first: unknown, second: unknown): number {
  const firstMissing = first === undefined || first === null
  const secondMissing = second === undefined || second === null
  if (firstMissing || secondMissing) return Number(firstMissing) - Number(secondMissing)
  const a = sortableValue(first)
  const b = sortableValue(second)
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedBy<T>(items: T[], orderBy: OrderBy[], read: (item: T, field: string) => unknown): T[] {
  if (orderBy.length === 0) return items
  return [...items].sort((first, second) => {
    for (const { field, direction } of orderBy) {
      const result = compareForOrder(read(first, field), read(second, field))
      if (result !== 0) return direction === 'desc' ? -result : result
    }
    return 0
  })
}

function project(entry: LogEntry, fields: string[]): Row {
  const row: Row = {}
  for (const field of fields) {
    const value = valueAtPath(entry, field)
    if (value !== undefined) row[field] = value
  }
  return row
}

function aggregateValue(aggregate: Aggregate, entries: LogEntry[]): unknown {
  if (aggregate.operation === 'count') return entries.length
  const values = entries.map((entry) => valueAtPath(entry, aggregate.field)).filter((value) => value !== undefined && value !== null)
  if (values.length === 0) return undefined
  const sorted = sortedBy(values, [{ field: '', direction: aggregate.operation === 'min' ? 'asc' : 'desc' }], (value) => value)
  return sorted[0]
}

function groupRows(entries: LogEntry[], groupBy: string[], aggregates: Aggregate[]): Row[] {
  const groups = new Map<string, LogEntry[]>()
  for (const entry of entries) {
    const key = JSON.stringify(groupBy.map((field) => valueAtPath(entry, field) ?? null))
    const members = groups.get(key)
    if (members) members.push(entry)
    else groups.set(key, [entry])
  }
  return [...groups.values()].map((members) => {
    const row: Row = {}
    for (const field of groupBy) row[field] = valueAtPath(members[0], field) ?? null
    for (const aggregate of aggregates) row[aggregate.outputName] = aggregateValue(aggregate, members)
    return row
  })
}

function distinctRows(entries: LogEntry[], field: string): Row[] {
  const values = new Set<string>()
  for (const entry of entries) {
    const value = valueAtPath(entry, field)
    if (value !== undefined && value !== null) values.add(String(value))
  }
  return [...values].sort().map((value) => ({ [field]: value }))
}

function limited(rows: Row[], limit: number): QueryResult {
  return { rows: rows.slice(0, limit), moreRows: Math.max(0, rows.length - limit) }
}

/** Filters, groups or projects, orders and limits `entries`. Group by, distinct and aggregates are what answer "which screen?" in ten lines. */
export function runQuery(entries: LogEntry[], query: Query): QueryResult {
  const matching = entries.filter((entry) => query.where.every((condition) => matches(entry, condition)))
  if (query.distinct) return limited(distinctRows(matching, query.distinct), query.limit)

  const aggregates = query.select.map(parseAggregate).filter((aggregate): aggregate is Aggregate => aggregate !== undefined)
  if (query.groupBy.length > 0 || aggregates.length > 0) {
    const selected = aggregates.length > 0 ? aggregates : [parseAggregate('count')!]
    const grouped = groupRows(matching, query.groupBy, selected)
    return limited(sortedBy(grouped, query.orderBy, (row, field) => row[field]), query.limit)
  }

  const ordered = sortedBy(matching, query.orderBy, valueAtPath)
  const rows = query.select.length > 0 ? ordered.map((entry) => project(entry, query.select)) : (ordered as unknown as Row[])
  return limited(rows, query.limit)
}
