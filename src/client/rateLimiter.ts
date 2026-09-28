import type { LogSeverity } from '../shared/types'
import { SEVERITY_ORDER } from '../shared/severity'
import { warnDeprecated } from '../shared/deprecate'

const DEFAULT_BURST_LIMIT = 50
const DEFAULT_RECHARGE_SECONDS_PER_LOG = 60
const DEFAULT_RESERVED_FOR_ERRORS = 10
const DEFAULT_DUPLICATE_LIMIT = 3
const DEFAULT_STORAGE_KEY = 'fsl_ratelimit'
const DEFAULT_SUMMARY_INTERVAL_MINUTES = 60
const DEFAULT_SUMMARY_MAX_AGE_DAYS = 7
const DEFAULT_MAX_PENDING_SUMMARIES = 50

// Fixed, not configurable — the seven knobs in RateLimitConfig are the whole
// documented surface (README, "Volume controls"). A second storage key for the
// summary queue would be an eighth nobody asked for.
const SUMMARY_STORAGE_KEY = 'fsl_pending_summaries'

/**
 * The flood this feature exists to survive is exactly "many distinct
 * messages" — a URL, an id, anything with a variable in the string — so
 * `state.signatures` cannot be left to grow one entry per message forever:
 * that eventually fills sessionStorage (a quota error, then the state is
 * silently lost) and makes every `allow()` parse an ever-larger map. Not a
 * config knob: nobody tunes this per app, it is a safety valve.
 */
const MAX_SIGNATURES = 200

export interface RateLimitConfig {
  /** The budget: how many logs can go out at once. Default 50. */
  burstLimit?: number
  /** After a burst, how many seconds before one more log recharges. Default 60. */
  rechargeSecondsPerLog?: number
  /** Of `burstLimit`, how many only ERROR and above may spend. A value over half of
   *  `burstLimit` is capped at half, with one warning. Default 10. */
  reservedForErrors?: number
  /** Full copies of one error before it is only counted. Default 3. */
  duplicateLimit?: number
  storageKey?: string
  /** How often a running count of repeats is sent as a summary. Default 60. */
  summaryIntervalMinutes?: number
  /** How long an unsent summary is kept before it is deleted, not sent. Default 7. */
  summaryMaxAgeDays?: number
  /** Most pending summaries kept at once; oldest are dropped first. Default 50. */
  maxPendingSummaries?: number

  /** @deprecated Use `burstLimit`. */
  sessionLimit?: number
  /** @deprecated Use `rechargeSecondsPerLog` (`60 / refillPerMinute`). */
  refillPerMinute?: number
  /** @deprecated Use `reservedForErrors` (`Math.round(errorReserve * burstLimit)`), a count rather than a share. */
  errorReserve?: number
}

/**
 * The state a single signature accumulates: how many full copies have gone
 * out (capped at `duplicateLimit`), the client-side id those copies carry as
 * `labels.repeatKey` (see the module doc below), and — once the limit is
 * passed — a running count of repeats waiting to become a summary.
 *
 * Deliberately thin: no label snapshot, no copy of the message. Those already
 * live in Cloud Logging on the full copies `repeatKey`/`repeatOf` link
 * together, and the message, screen, releaseId and userId are already
 * encoded in this signature's own key (see `parseSignatureKey`) — storing
 * them again here would be a second copy of exactly the data this cap exists
 * to stop piling up, one entry per distinct message, without bound.
 */
interface SignatureState {
  count: number
  repeatKey: string
  repeatCount?: number
  firstSeen?: number
  lastSeen?: number
  /** Last time this signature was touched by `allow()` — what eviction sorts by. */
  lastTouched: number
}

interface RateLimitState {
  available: number
  lastRefillAt: number
  signatures: Record<string, SignatureState>
}

/**
 * A repeat count waiting to be sent as a WARNING summary. Queued in
 * `localStorage` so it survives the tab closing — `sessionStorage` does not.
 *
 * `bootId` is what `sentLate` is built from: it is the module's own load-time
 * id, not anything persisted. A summary queued during an earlier page load
 * carries a different `bootId` than the one currently running, so popping it
 * here reveals it as "from a previous visit" without needing a server
 * round-trip or a wall-clock guess.
 *
 * `message`/`errorType`/`screen`/`releaseId`/`userId` are short fields
 * rebuilt once from the signature's key when the summary is created (see
 * `parseSignatureKey`) — not a full label copy. Everything else about the
 * error (browser, platform, stack, breadcrumbs…) is already in Cloud Logging
 * on the full copies `repeatOf` points back to.
 */
export interface PendingSummary {
  id: string
  message: string
  errorType?: string
  screen?: string
  releaseId?: string
  userId?: string
  repeatOf: string
  repeatCount: number
  firstSeen: string
  lastSeen: string
  createdAt: number
  bootId: string
}

export interface SentSummary {
  id: string
  message: string
  errorType?: string
  screen?: string
  releaseId?: string
  userId?: string
  repeatOf: string
  repeatCount: number
  firstSeen: string
  lastSeen: string
  sentLate: boolean
}

/** The config actually held in module scope — always the new names, never the aliases. */
type ResolvedRateLimitConfig = Required<
  Omit<RateLimitConfig, 'sessionLimit' | 'refillPerMinute' | 'errorReserve'>
>

// Session-scoped by design: one browser session, one budget. Deliberately not
// per-Logger — see the module-scoped state rule in CLAUDE.md.
let config: ResolvedRateLimitConfig = {
  burstLimit: DEFAULT_BURST_LIMIT,
  rechargeSecondsPerLog: DEFAULT_RECHARGE_SECONDS_PER_LOG,
  reservedForErrors: DEFAULT_RESERVED_FOR_ERRORS,
  duplicateLimit: DEFAULT_DUPLICATE_LIMIT,
  storageKey: DEFAULT_STORAGE_KEY,
  summaryIntervalMinutes: DEFAULT_SUMMARY_INTERVAL_MINUTES,
  summaryMaxAgeDays: DEFAULT_SUMMARY_MAX_AGE_DAYS,
  maxPendingSummaries: DEFAULT_MAX_PENDING_SUMMARIES,
}

/**
 * `reservedForErrors` above half of `burstLimit` would leave warnings no room
 * to spend at all, so it is capped there — whether it arrived directly or was
 * converted from the deprecated `errorReserve`. Warned once per process, like
 * the renames themselves.
 */
let warnedReservedForErrorsCapped = false
function capReservedForErrors(value: number, burstLimit: number): number {
  const half = burstLimit / 2
  if (value <= half) return value
  if (!warnedReservedForErrorsCapped) {
    warnedReservedForErrorsCapped = true
    console.warn('[fsl] "reservedForErrors" above half of "burstLimit" is capped at half, so warnings always have room.')
  }
  return half
}

export function configureRateLimiter(options: RateLimitConfig): void {
  const { sessionLimit, refillPerMinute, errorReserve, burstLimit, rechargeSecondsPerLog, reservedForErrors, ...rest } =
    options

  if (sessionLimit !== undefined) warnDeprecated('sessionLimit', 'burstLimit')
  const resolvedBurstLimit = burstLimit ?? sessionLimit

  if (refillPerMinute !== undefined) warnDeprecated('refillPerMinute', 'rechargeSecondsPerLog')
  const resolvedRecharge = rechargeSecondsPerLog ?? (refillPerMinute !== undefined ? 60 / refillPerMinute : undefined)

  // Needed to convert `errorReserve` (a share) and to cap either name — both
  // read the burst limit this same call is possibly also changing.
  const effectiveBurstLimit = resolvedBurstLimit ?? config.burstLimit

  if (errorReserve !== undefined) warnDeprecated('errorReserve', 'reservedForErrors')
  const rawReservedForErrors =
    reservedForErrors ?? (errorReserve !== undefined ? Math.round(errorReserve * effectiveBurstLimit) : undefined)
  const resolvedReservedForErrors =
    rawReservedForErrors !== undefined ? capReservedForErrors(rawReservedForErrors, effectiveBurstLimit) : undefined

  config = {
    ...config,
    ...rest,
    ...(resolvedBurstLimit !== undefined ? { burstLimit: resolvedBurstLimit } : {}),
    ...(resolvedRecharge !== undefined ? { rechargeSecondsPerLog: resolvedRecharge } : {}),
    ...(resolvedReservedForErrors !== undefined ? { reservedForErrors: resolvedReservedForErrors } : {}),
  }
}

// This tab's identity for `sentLate`. Regenerated by `resetRateLimiter`, which
// is how tests simulate a new visit — a real reload gets a new one for free,
// since the module (and this `let`) is re-evaluated from scratch.
let bootId = generateId()

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

function defaultState(): RateLimitState {
  return { available: config.burstLimit, lastRefillAt: Date.now(), signatures: {} }
}

function readState(): RateLimitState {
  try {
    const stored = sessionStorage.getItem(config.storageKey)
    return stored ? (JSON.parse(stored) as RateLimitState) : defaultState()
  } catch {
    return defaultState()
  }
}

function writeState(state: RateLimitState): void {
  try {
    sessionStorage.setItem(config.storageKey, JSON.stringify(state))
  } catch {
    // sessionStorage full or unavailable — rate limiting degrades, logging continues
  }
}

function readSummaryQueue(): PendingSummary[] {
  try {
    const stored = localStorage.getItem(SUMMARY_STORAGE_KEY)
    return stored ? (JSON.parse(stored) as PendingSummary[]) : []
  } catch {
    return []
  }
}

function writeSummaryQueue(queue: PendingSummary[]): void {
  try {
    localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(queue))
  } catch {
    // localStorage full or unavailable — summaries degrade, logging continues
  }
}

function isExpired(summary: PendingSummary, now: number): boolean {
  return now - summary.createdAt >= config.summaryMaxAgeDays * 24 * 60 * 60 * 1000
}

/**
 * Refill the budget for the time elapsed since it was last touched, capped at
 * `burstLimit`. Mutates `state` in place; the caller decides whether the
 * result is worth persisting.
 */
function refill(state: RateLimitState, now: number): void {
  const elapsedMinutes = (now - state.lastRefillAt) / 60_000
  if (elapsedMinutes <= 0) return
  const perMinute = 60 / config.rechargeSecondsPerLog
  state.available = Math.min(config.burstLimit, state.available + elapsedMinutes * perMinute)
  state.lastRefillAt = now
}

/**
 * Build the key used to recognise a repeat of the same problem. Two occurrences
 * count as duplicates only if the message and the screen both match, so the same
 * error from two different screens is not collapsed into one.
 *
 * This is coarse: the same error reached by two different paths on ONE screen
 * still collapses, and the second path can be suppressed before anyone sees it.
 * See #29 — deriving the path from breadcrumbs would discriminate properly,
 * without the staleness of a span someone has to remember to clear.
 */
export function signatureFor(
  error: Error | string,
  screen?: string,
): string {
  // A JSON list, not a joined string: a summary rebuilds the name, message and
  // screen from this key (parseSignatureKey), and a message containing `:` or
  // `|` — "upload failed: timeout" — must not split into the wrong fields.
  const errorType = error instanceof Error ? error.name : null
  const message = error instanceof Error ? error.message : String(error)
  return JSON.stringify([errorType, message, screen ?? ''])
}

/** A signature as a person reads it, for the console: `TypeError: cannot read 'id' | checkout`. */
export function describeSignature(signature: string): string {
  const { errorType, message, screen } = parseSignature(signature)
  return `${errorType ? `${errorType}: ` : ''}${message}${screen ? ` | ${screen}` : ''}`
}

function parseSignature(signature: string): { errorType?: string; message: string; screen?: string } {
  try {
    const [errorType, message, screen] = JSON.parse(signature) as [string | null, string, string]
    return { errorType: errorType ?? undefined, message, screen: screen || undefined }
  } catch {
    // Not one of ours — keep it whole rather than guess at its parts.
    return { message: signature }
  }
}

/**
 * A signature is further scoped to the release and the user before it is
 * counted — two releases, or two people on one machine, must never share one
 * running count. See README, "Repeats are counted, not dropped".
 */
function compoundKey(signature: string, labels: Record<string, string | undefined> | undefined): string {
  return JSON.stringify([signature, labels?.releaseId ?? '', labels?.userId ?? ''])
}

/**
 * The inverse of `compoundKey` + `signatureFor`: recover the name, message,
 * screen, releaseId and userId a summary needs from the key that already
 * holds them, rather than storing a second copy per signature — see
 * `SignatureState`'s doc for why that copy has to go. Both are JSON lists, so
 * the fields come back exactly, whatever characters a message contains.
 */
function parseSignatureKey(key: string): {
  errorType?: string
  message: string
  screen?: string
  releaseId?: string
  userId?: string
} {
  try {
    const [signature, releaseId, userId] = JSON.parse(key) as [string, string, string]
    return { ...parseSignature(signature), releaseId: releaseId || undefined, userId: userId || undefined }
  } catch {
    return { message: key }
  }
}

export type RateLimitDecision =
  | { allowed: true; repeatKey?: string }
  | { allowed: false; reason: 'session-limit' | 'reserve' | 'duplicate'; signature?: string }

export interface AllowOptions {
  signature?: string
  severity: LogSeverity
  labels?: Record<string, string | undefined>
}

/**
 * Decide whether one log may be sent, and consume its budget if so.
 *
 * Check and consume are one operation on purpose. They used to be separate
 * exports called from two different layers, which meant an error was checked
 * against the session limit twice and counted against it twice — a configured
 * limit of 50 was really 25 for errors. A single call cannot double-count, and
 * cannot be checked without consuming.
 *
 * Pass a `signature` to opt this log into duplicate suppression. Any severity
 * may do so; it is not reserved for errors. Once `duplicateLimit` full copies
 * have gone out, further occurrences are neither sent nor refused outright —
 * they are counted here, toward the next repeat summary, and cost no budget.
 */
/**
 * Keep `state.signatures` at or under `MAX_SIGNATURES`. Evicts the oldest
 * (by `lastTouched`) signatures that have no pending repeat count first;
 * a signature with an unsent `repeatCount` is never dropped, even if that
 * leaves the map over the cap — losing a count already promised to a summary
 * is worse than a temporarily oversized map.
 */
function pruneSignatures(state: RateLimitState): void {
  const keys = Object.keys(state.signatures)
  let overflow = keys.length - MAX_SIGNATURES
  if (overflow <= 0) return

  const evictable = keys
    .filter((k) => state.signatures[k].repeatCount === undefined)
    .sort((a, b) => state.signatures[a].lastTouched - state.signatures[b].lastTouched)

  for (const k of evictable) {
    if (overflow <= 0) break
    delete state.signatures[k]
    overflow--
  }
}

export function allow(options: AllowOptions): RateLimitDecision {
  const now = Date.now()
  const state = readState()
  refill(state, now)

  let key: string | undefined
  let sig: SignatureState | undefined
  if (options.signature !== undefined) {
    key = compoundKey(options.signature, options.labels)
    sig = state.signatures[key] ?? { count: 0, repeatKey: generateId(), lastTouched: now }
    sig.lastTouched = now
  }

  if (sig && key && sig.count >= config.duplicateLimit) {
    sig.repeatCount = (sig.repeatCount ?? 0) + 1
    if (sig.firstSeen === undefined) sig.firstSeen = now
    sig.lastSeen = now
    state.signatures[key] = sig
    pruneSignatures(state)
    writeState(state)
    return { allowed: false, reason: 'duplicate', signature: options.signature }
  }

  const reserveThreshold = config.reservedForErrors
  if (state.available < 1) {
    writeState(state)
    return { allowed: false, reason: 'session-limit' }
  }
  // "ERROR and above" as a rank, not the literal string 'ERROR' — so the check
  // stays right if a more severe level is ever added to SEVERITY_ORDER.
  if (state.available <= reserveThreshold && SEVERITY_ORDER[options.severity] > SEVERITY_ORDER.ERROR) {
    writeState(state)
    return { allowed: false, reason: 'reserve' }
  }

  state.available -= 1
  if (sig && key) {
    sig.count += 1
    state.signatures[key] = sig
    pruneSignatures(state)
  }
  writeState(state)
  return { allowed: true, repeatKey: sig?.repeatKey }
}

/**
 * Move any signature's accumulated repeats into the pending-summary queue —
 * every one whose window (`summaryIntervalMinutes`) has elapsed, or every one
 * with anything to send when `force` is true (the tab going hidden).
 *
 * Only the counting resets; `count` (full copies already sent) is untouched,
 * so a signature stays in "counting" mode across summary windows rather than
 * sending three more full copies before the next summary.
 */
export function flushDueSummaries(force = false): void {
  const now = Date.now()
  const state = readState()
  refill(state, now)
  const intervalMs = config.summaryIntervalMinutes * 60_000

  let changed = false
  for (const key of Object.keys(state.signatures)) {
    const sig = state.signatures[key]
    if (!sig.repeatCount || sig.firstSeen === undefined || sig.lastSeen === undefined) continue
    if (!force && now - sig.firstSeen < intervalMs) continue

    const { errorType, message, screen, releaseId, userId } = parseSignatureKey(key)
    const maxAgeMs = config.summaryMaxAgeDays * 24 * 60 * 60 * 1000
    const queue = readSummaryQueue().filter((s) => now - s.createdAt < maxAgeMs)
    queue.push({
      id: generateId(),
      message,
      errorType,
      screen,
      releaseId,
      userId,
      repeatOf: sig.repeatKey,
      repeatCount: sig.repeatCount,
      firstSeen: new Date(sig.firstSeen).toISOString(),
      lastSeen: new Date(sig.lastSeen).toISOString(),
      createdAt: now,
      bootId,
    })
    // Keep the newest when the queue is over its cap.
    const trimmed = queue.length > config.maxPendingSummaries
      ? queue.slice(queue.length - config.maxPendingSummaries)
      : queue
    writeSummaryQueue(trimmed)

    sig.repeatCount = undefined
    sig.firstSeen = undefined
    sig.lastSeen = undefined
    changed = true
  }

  if (changed) writeState(state)
}

function toSentSummary(s: PendingSummary): SentSummary {
  return {
    id: s.id,
    message: s.message,
    errorType: s.errorType,
    screen: s.screen,
    releaseId: s.releaseId,
    userId: s.userId,
    repeatOf: s.repeatOf,
    repeatCount: s.repeatCount,
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    sentLate: s.bootId !== bootId,
  }
}

/**
 * Look at every pending summary not past `summaryMaxAgeDays`, WITHOUT
 * removing it from the queue. A summary may only leave the queue once its
 * send has actually succeeded — see `acknowledgeSummary` — so a failed send
 * (offline, or the tab tearing down right after the `visibilitychange` that
 * triggered this) leaves it queued for the next flush or the next visit to
 * retry, instead of losing it. `sentLate` is true for anything queued by an
 * earlier page load (a different `bootId`): the case the README's "next
 * visit sends them" describes.
 *
 * Expired entries ARE removed here — there is no send to wait on for those.
 */
export function peekPendingSummaries(): SentSummary[] {
  const now = Date.now()
  const queue = readSummaryQueue()
  const fresh = queue.filter((s) => !isExpired(s, now))
  if (fresh.length !== queue.length) writeSummaryQueue(fresh)
  return fresh.map(toSentSummary)
}

/**
 * Remove one summary from the queue by id, once its send has resolved. A
 * retry that calls this again for an id already gone is a no-op — it never
 * re-adds anything, so it cannot create a second entry.
 */
export function acknowledgeSummary(id: string): void {
  const queue = readSummaryQueue()
  const next = queue.filter((s) => s.id !== id)
  if (next.length !== queue.length) writeSummaryQueue(next)
}

/**
 * Test-only reset. There is no `beforeunload` wiring any more — the budget
 * lives in `sessionStorage` on purpose, so a reload keeps it — but tests still
 * need a way to start a clean session, and to simulate a genuinely new visit
 * (a new tab gets a new `bootId` for free, since the module reloads with it;
 * a test in the same process cannot, so this rotates it explicitly).
 */
export function resetRateLimiter(): void {
  try {
    sessionStorage.removeItem(config.storageKey)
  } catch {
    // Silently fail
  }
  bootId = generateId()
}
