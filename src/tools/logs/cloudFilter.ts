import type { Condition } from './query.js'

const RESOURCE_TYPES = ['cloud_function', 'cloud_run_revision']
const SAFE_LABEL_KEY = /^[A-Za-z0-9_-]+$/

export interface CloudFilterInput {
  since: Date
  where: Condition[]
  knownLabelKeys: ReadonlySet<string>
  repeatKey?: string
}

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function labelEquals(key: string, value: string): string {
  return `(labels.${key}=${quoted(value)} OR jsonPayload.labels.${key}=${quoted(value)})`
}

function asIsoTime(value: string): string | undefined {
  const instant = new Date(value)
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString()
}

function serverSideTerm(condition: Condition, knownLabelKeys: ReadonlySet<string>): string | undefined {
  const { field, operator, value } = condition
  if (field === 'severity' && operator === '=') return `severity=${quoted(value.toUpperCase())}`
  if (field === 'timestamp' && (operator === '>=' || operator === '<=')) {
    const iso = asIsoTime(value)
    return iso === undefined ? undefined : `timestamp${operator}${quoted(iso)}`
  }
  if (field === 'functionName' && operator === '=') {
    return `(resource.labels.function_name=${quoted(value)} OR resource.labels.service_name=${quoted(value.toLowerCase())})`
  }
  const labelKey = field.startsWith('labels.') ? field.slice('labels.'.length) : undefined
  if (labelKey !== undefined && operator === '=' && SAFE_LABEL_KEY.test(labelKey) && knownLabelKeys.has(labelKey)) {
    return labelEquals(labelKey, value)
  }
  return undefined
}

/**
 * The server-side half of a query. A condition is sent to Cloud Logging only when it is
 * certain to mean the same thing there as it does in `runQuery`; a label key nobody has
 * confirmed is left to `runQuery`, because a typo pushed to the server returns zero
 * entries and nothing to compare the key against.
 */
export function buildCloudFilter(input: CloudFilterInput): string {
  const resource = `(${RESOURCE_TYPES.map((type) => `resource.type="${type}"`).join(' OR ')})`
  const terms = [resource, 'NOT logName:"cloudaudit.googleapis.com"', `timestamp>=${quoted(input.since.toISOString())}`]
  if (input.repeatKey !== undefined) {
    terms.push(`(${labelEquals('repeatKey', input.repeatKey)} OR ${labelEquals('repeatOf', input.repeatKey)})`)
  }
  for (const condition of input.where) {
    const term = serverSideTerm(condition, input.knownLabelKeys)
    if (term !== undefined) terms.push(term)
  }
  return terms.join(' AND ')
}
