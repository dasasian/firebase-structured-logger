/**
 * The one range shape this package's own `peerDependencies` use: `>=X.Y.Z`.
 *
 * Not a general semver comparator — `unsupported-peer` reads ranges from this
 * package's own `package.json` at runtime rather than copying them into doctor
 * (so the two cannot drift), and every peer range there is a plain minimum today.
 * If a future range needs `^` or `||`, this returns `undefined` rather than a
 * wrong answer, and the caller skips the check instead of guessing.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)/
const MINIMUM_RANGE = /^>=\s*(\d+)\.(\d+)\.(\d+)/

function parseVersion(version: string): [number, number, number] | undefined {
  const match = VERSION.exec(version)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/**
 * Whether `version` meets `range`, or `undefined` when `range` is not a plain
 * `>=X.Y.Z` minimum — the caller's signal to skip rather than misreport.
 */
export function meetsMinimum(version: string, range: string): boolean | undefined {
  const rangeMatch = MINIMUM_RANGE.exec(range.trim())
  if (!rangeMatch) return undefined
  const minimum: [number, number, number] = [Number(rangeMatch[1]), Number(rangeMatch[2]), Number(rangeMatch[3])]
  const parsed = parseVersion(version)
  if (!parsed) return undefined
  return compare(parsed, minimum) >= 0
}

/** The leading major version number in a string like `22.11.0`, `^22`, or `nodejs20`. */
export function leadingMajorVersion(text: string): number | undefined {
  const match = /(\d+)/.exec(text)
  return match ? Number(match[1]) : undefined
}
