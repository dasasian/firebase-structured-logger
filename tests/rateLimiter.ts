/**
 * Rate limiter unit tests.
 *
 * `allow()` is deliberately one operation: it decides AND consumes. The two
 * used to be separate exports (`canLogEvent`/`canLogError` + `recordLog`/
 * `recordError`) called from two different layers, which meant an error was
 * checked against the session limit twice and counted against it twice — a
 * configured limit of 50 was really 25 for errors.
 *
 * Run: npx tsx tests/rateLimiter.ts
 */

// Must come first — client/logger reads `navigator` at module load.
import { sessionStorageStub, localStorageStub, withFrozenTime, listenerCount } from './browserStubs.js'

import {
  allow,
  signatureFor,
  configureRateLimiter,
  resetRateLimiter,
  flushDueSummaries,
  peekPendingSummaries,
} from '../src/client/rateLimiter.js'
import { assert, reportResults } from './testHelpers.js'

const STORAGE_KEY = 'fsl_ratelimit'
const SUMMARY_KEY = 'fsl_pending_summaries'

function reset() {
  configureRateLimiter({
    burstLimit: 50,
    rechargeSecondsPerLog: 60,
    reservedForErrors: 10,
    duplicateLimit: 3,
    storageKey: STORAGE_KEY,
    summaryIntervalMinutes: 60,
    summaryMaxAgeDays: 7,
    maxPendingSummaries: 50,
  })
  sessionStorageStub.failing = false
  localStorageStub.failing = false
  localStorageStub.setItem(SUMMARY_KEY, '[]')
  resetRateLimiter()
}

function storedState(): { available: number; signatures: Record<string, unknown> } | null {
  const raw = sessionStorageStub.peek(STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

function spent(burstLimit = 50): number {
  return burstLimit - (storedState()?.available ?? burstLimit)
}

// --- Session limit and refill ---

function testSessionLimit() {
  console.log('\nTest: session limit')
  reset()
  configureRateLimiter({ burstLimit: 3, reservedForErrors: 0 })

  assert('1st is allowed', allow({ severity: 'INFO' }).allowed)
  assert('2nd is allowed', allow({ severity: 'INFO' }).allowed)
  assert('3rd is allowed', allow({ severity: 'INFO' }).allowed)

  const fourth = allow({ severity: 'INFO' })
  assert('4th is refused', !fourth.allowed)
  assert('and the reason is the session limit', !fourth.allowed && fourth.reason === 'session-limit')
  assert('5th is still refused', !allow({ severity: 'INFO' }).allowed)
}

function testEachAllowCostsExactlyOne() {
  console.log('\nTest: one allowed log costs exactly one unit of budget')
  reset()

  allow({ severity: 'INFO' })
  assert('a plain log increments once', spent() === 1, `got: ${spent()}`)

  // The regression this file exists for. An error used to be counted twice:
  // once by recordError() and again by recordLog() inside send().
  reset()
  allow({ severity: 'ERROR', signature: signatureFor(new Error('boom'), 'Home') })
  assert('a signed log also increments once', spent() === 1, `got: ${spent()}`)
}

function testRefusedLogsCostNothing() {
  console.log('\nTest: a refused log does not consume budget')
  reset()
  configureRateLimiter({ burstLimit: 2, duplicateLimit: 1, reservedForErrors: 0 })

  const sig = signatureFor(new Error('dupe'), 'Home')
  const now = 1_700_000_000_000
  withFrozenTime(now, () => {
    allow({ severity: 'INFO', signature: sig })                    // 1st: allowed, spent = 1
    const refused = allow({ severity: 'INFO', signature: sig })    // 2nd: duplicate, counted instead
    assert('the duplicate was refused', !refused.allowed)
    assert('a counted duplicate did not spend budget', spent(2) === 1, `got: ${spent(2)}`)

    assert('the remaining budget is still usable', allow({ severity: 'INFO' }).allowed)
  })
}

function testBudgetRefillsOverTime() {
  console.log('\nTest: the budget refills — a minute back after emptying it, full after 50')
  reset()
  // No reserve here — this test is about refill timing, not the reserve gate.
  configureRateLimiter({ burstLimit: 50, rechargeSecondsPerLog: 60, reservedForErrors: 0 })

  const t0 = 1_700_000_000_000
  withFrozenTime(t0, () => {
    for (let i = 0; i < 50; i++) assert(`spend ${i + 1}/50 allowed`, allow({ severity: 'INFO' }).allowed)
    assert('the budget is now empty', !allow({ severity: 'INFO' }).allowed)
  })

  withFrozenTime(t0 + 60_000, () => {
    assert('a minute later, one log goes through', allow({ severity: 'INFO' }).allowed)
    assert('but a second one does not — only one minute refilled', !allow({ severity: 'INFO' }).allowed)
  })

  // A separate, fresh session: emptied at t0 again, then left untouched for a
  // full 50 minutes — the earlier probe spend must not confound this.
  reset()
  configureRateLimiter({ burstLimit: 50, rechargeSecondsPerLog: 60, reservedForErrors: 0 })
  withFrozenTime(t0, () => {
    for (let i = 0; i < 50; i++) allow({ severity: 'INFO' })
  })
  withFrozenTime(t0 + 50 * 60_000, () => {
    for (let i = 0; i < 50; i++) assert(`after 50 minutes, spend ${i + 1}/50 allowed`, allow({ severity: 'INFO' }).allowed)
    assert('and the budget is full, not more', !allow({ severity: 'INFO' }).allowed)
  })
}

function testReloadDoesNotResetTheBudget() {
  console.log('\nTest: a reload in the same tab does not reset the budget')
  reset()
  configureRateLimiter({ burstLimit: 5, reservedForErrors: 0 })

  // Frozen throughout — otherwise the tiny real elapsed time between calls
  // refills a sliver of budget, which is true and harmless in production but
  // makes `spent()` a non-integer here.
  const now = 1_700_000_000_000
  withFrozenTime(now, () => {
    allow({ severity: 'INFO' }); allow({ severity: 'INFO' }); allow({ severity: 'INFO' })
  })
  assert('3 spent so far', spent(5) === 3, `got: ${spent(5)}`)

  // A reload re-executes the module but never touches sessionStorage — there
  // is nothing left to call. Simulated here simply by *not* calling
  // resetRateLimiter and reading state again, exactly as a fresh module load
  // reading an existing sessionStorage entry would.
  assert('the stored budget survives untouched', spent(5) === 3, `got: ${spent(5)}`)
  withFrozenTime(now, () => {
    assert('and logging continues from where it left off', allow({ severity: 'INFO' }).allowed)
  })
  assert('4 spent, not reset to 1', spent(5) === 4, `got: ${spent(5)}`)
}

// --- Error reserve ---

function testErrorReserve() {
  console.log('\nTest: the last 20% of the budget is reserved for ERROR and above')
  reset()
  configureRateLimiter({ burstLimit: 50, reservedForErrors: 10 })

  // Frozen throughout — spending right up to the reserve boundary leaves no
  // room for the real-time refill sliver that would otherwise creep in.
  const now = 1_700_000_000_000
  withFrozenTime(now, () => {
    for (let i = 0; i < 40; i++) assert(`non-reserved spend ${i + 1}/40 allowed`, allow({ severity: 'INFO' }).allowed)
    assert('80% is now spent', spent() === 40, `got: ${spent()}`)

    const warning = allow({ severity: 'WARNING' })
    assert('a WARNING is refused once only the reserve is left', !warning.allowed)
    assert('reason is the reserve', !warning.allowed && warning.reason === 'reserve')
    assert('the reserve was not spent', spent() === 40, `got: ${spent()}`)

    const error = allow({ severity: 'ERROR' })
    assert('an ERROR is still sent', error.allowed)
    assert('and it spent from the reserve', spent() === 41, `got: ${spent()}`)
  })
}

/**
 * The reserve is "ERROR and above" by rank (SEVERITY_ORDER), so every level
 * less severe than ERROR is refused at the line — not just WARNING.
 */
/**
 * The count refills continuously, so it is almost never a whole number. A reserve
 * check of "available <= reserve" lets a warning through at 1.0001 with a reserve
 * of 1, and that warning spends the reserve. Found as a CI-only flake: on a fast
 * machine the calls land in one millisecond and the count stays exactly 1.
 */
function testFractionalRechargeDoesNotBreachTheReserve() {
  console.log('\nTest: a part-recharged log does not let a warning into the reserve')
  reset()
  configureRateLimiter({ burstLimit: 3, reservedForErrors: 1, rechargeSecondsPerLog: 60, duplicateLimit: 99 })

  const t0 = 1_700_000_000_000
  withFrozenTime(t0, () => {
    assert('INFO 1 allowed', allow({ severity: 'INFO' }).allowed)
    assert('INFO 2 allowed — at the reserve line now', allow({ severity: 'INFO' }).allowed)
  })
  // One second later: a sixtieth of a log has recharged, so the count is ~1.017.
  withFrozenTime(t0 + 1_000, () => {
    const warning = allow({ severity: 'WARNING' })
    assert('a WARNING is still refused at the reserve', !warning.allowed && warning.reason === 'reserve',
      JSON.stringify(warning))
    assert('an ERROR can spend the reserve', allow({ severity: 'ERROR' }).allowed)
  })
}

function testReserveIsByRank() {
  console.log('\nTest: at the reserve line, ERROR is allowed and every less severe level refused')
  reset()
  configureRateLimiter({ burstLimit: 10, reservedForErrors: 5 })

  const now = 1_700_000_000_000
  withFrozenTime(now, () => {
    for (let i = 0; i < 5; i++) allow({ severity: 'INFO' })
    assert('half the budget is spent, at the reserve line', spent(10) === 5, `got: ${spent(10)}`)

    assert('WARNING is refused at the reserve', !allow({ severity: 'WARNING' }).allowed)
    assert('NOTICE is refused at the reserve', !allow({ severity: 'NOTICE' }).allowed)
    assert('INFO is refused at the reserve', !allow({ severity: 'INFO' }).allowed)
    assert('DEBUG is refused at the reserve', !allow({ severity: 'DEBUG' }).allowed)
    assert('ERROR is allowed', allow({ severity: 'ERROR' }).allowed)
  })
}

/**
 * A summary rebuilds its fields from the signature key, so a message holding
 * the characters a joined key would split on must come back whole.
 */
function testSignatureSurvivesColonsAndPipes() {
  console.log('\nTest: a message with ":" and "|" comes back whole in its summary')
  reset()
  let summaries: ReturnType<typeof peekPendingSummaries> = []
  configureRateLimiter({ duplicateLimit: 1 })
  const now = 1_700_000_000_000
  withFrozenTime(now, () => {
    const sig = signatureFor('upload failed: timeout | retrying', 'Up|load')
    allow({ severity: 'WARNING', signature: sig, labels: { releaseId: 'r1', userId: 'u1' } })
    allow({ severity: 'WARNING', signature: sig, labels: { releaseId: 'r1', userId: 'u1' } })
    flushDueSummaries(true)
    // Read inside the frozen clock: outside it, a summary created "in 2023"
    // is past summaryMaxAgeDays and is correctly filtered as expired.
    summaries = peekPendingSummaries()
  })
  const [summary] = summaries
  assert('the message is whole', summary?.message === 'upload failed: timeout | retrying', `got: ${summary?.message}`)
  assert('no error type is invented from the colon', summary?.errorType === undefined, `got: ${summary?.errorType}`)
  assert('the screen is whole', summary?.screen === 'Up|load', `got: ${summary?.screen}`)
  assert('releaseId and userId come back', summary?.releaseId === 'r1' && summary?.userId === 'u1')
}

// --- Duplicate suppression becomes repeat counting ---

function testDuplicateSuppression() {
  console.log('\nTest: duplicate suppression')
  reset()
  configureRateLimiter({ duplicateLimit: 2 })

  const sig = signatureFor(new Error('same failure'), 'Checkout')
  assert('1st occurrence allowed', allow({ severity: 'ERROR', signature: sig }).allowed)
  assert('2nd occurrence allowed', allow({ severity: 'ERROR', signature: sig }).allowed)

  const third = allow({ severity: 'ERROR', signature: sig })
  assert('3rd is counted, not sent', !third.allowed)
  assert('reason is duplicate', !third.allowed && third.reason === 'duplicate')
  assert('the signature is reported back', !third.allowed && third.signature === sig)
}

function testUnsignedLogsAreNeverSuppressedAsDuplicates() {
  console.log('\nTest: a log with no signature opts out of duplicate suppression')
  reset()
  configureRateLimiter({ burstLimit: 50, duplicateLimit: 1 })

  for (let i = 0; i < 10; i++) {
    assert(`unsigned log ${i + 1} allowed`, allow({ severity: 'INFO' }).allowed)
  }
}

function testSuppressionIsAvailableToAnySeverity() {
  console.log('\nTest: suppression is keyed on the signature, not on being an error')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  // A warning can opt in with a plain string — nothing here is error-specific.
  const warnSig = signatureFor('deprecated_api_used', 'Settings')
  assert('1st warning allowed', allow({ severity: 'WARNING', signature: warnSig }).allowed)
  assert('repeat warning counted', !allow({ severity: 'WARNING', signature: warnSig }).allowed)
}

function testSignatureIsScopedToContext() {
  console.log('\nTest: the signature includes the screen')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  const error = new Error('same failure')
  allow({ severity: 'ERROR', signature: signatureFor(error, 'Checkout') })

  assert('same error, same place → counted', !allow({ severity: 'ERROR', signature: signatureFor(error, 'Checkout') }).allowed)
  assert('same error, other screen → allowed', allow({ severity: 'ERROR', signature: signatureFor(error, 'Settings') }).allowed)
  assert('different message → allowed', allow({ severity: 'ERROR', signature: signatureFor(new Error('other'), 'Checkout') }).allowed)

  const named = new Error('same failure')
  named.name = 'TypeError'
  assert('different error name → allowed', allow({ severity: 'ERROR', signature: signatureFor(named, 'Checkout') }).allowed)
}

function testStringErrorsAreSupported() {
  console.log('\nTest: string errors get a signature too')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  assert('1st string allowed', allow({ severity: 'WARNING', signature: signatureFor('plain failure', 'Home') }).allowed)
  assert('repeat string counted', !allow({ severity: 'WARNING', signature: signatureFor('plain failure', 'Home') }).allowed)
  assert('different string allowed', allow({ severity: 'WARNING', signature: signatureFor('other failure', 'Home') }).allowed)
}

function testSessionLimitOutranksDuplicate() {
  console.log('\nTest: the session limit is checked before the duplicate rule')
  reset()
  configureRateLimiter({ burstLimit: 2, duplicateLimit: 99, reservedForErrors: 0 })

  allow({ severity: 'INFO' }); allow({ severity: 'INFO' })
  const refused = allow({ severity: 'ERROR', signature: signatureFor(new Error('fresh'), 'Home') })
  assert('a brand-new error is still refused at the cap', !refused.allowed)
  assert('reported as the session limit, not a duplicate', !refused.allowed && refused.reason === 'session-limit')
}

/**
 * The flood this feature exists for is exactly "many different messages" —
 * URLs, ids, anything with a variable in the string. Left unbounded,
 * `state.signatures` grows one entry per distinct message forever, which
 * eventually fills sessionStorage (a quota error, then the whole state is
 * silently lost) and makes every `allow()` parse an ever-larger map.
 */
function testSignatureMapIsBounded() {
  console.log('\nTest: the signature map is capped, and a signature with pending repeats survives the cap')
  reset()
  configureRateLimiter({ burstLimit: 5000, duplicateLimit: 1 })

  const t0 = 1_700_000_000_000
  const survivorSig = signatureFor(new Error('keep-me'), 'Home')
  withFrozenTime(t0, () => {
    allow({ severity: 'WARNING', signature: survivorSig })       // full copy
    allow({ severity: 'WARNING', signature: survivorSig })       // repeat — has a pending count
  })

  withFrozenTime(t0 + 1, () => {
    for (let i = 0; i < 1000; i++) {
      allow({ severity: 'WARNING', signature: signatureFor(new Error(`msg-${i}`), 'Home') })
    }
  })

  const state = storedState()
  const count = Object.keys(state?.signatures ?? {}).length
  assert('the signature map stays bounded', count <= 200, `got: ${count}`)
  // Keys are JSON lists: [signature, releaseId, userId].
  const survivorKey = Object.keys(state?.signatures ?? {}).find(
    (k) => (JSON.parse(k) as [string, string, string])[0] === survivorSig,
  )
  assert('the signature with pending repeats survived the cap', survivorKey !== undefined)
}

// --- Repeats become summaries ---

function testTwoHundredCopiesSendThreeFullEntriesAndOneSummary() {
  console.log('\nTest: 200 copies of one error → 3 full copies + one summary of 197')
  reset()
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 3 })

  const sig = signatureFor(new Error('cart sync failed'), 'Checkout')
  const labels = { appId: 'app', releaseId: 'r1', userId: 'u1' }
  const t0 = 1_700_000_000_000

  let fullCopies = 0
  let firstRepeatAt = -1
  let lastRepeatAt = -1
  withFrozenTime(t0, () => {
    for (let i = 0; i < 3; i++) {
      const decision = allow({ severity: 'ERROR', signature: sig, labels })
      if (decision.allowed) fullCopies++
    }
  })
  for (let i = 0; i < 197; i++) {
    const now = t0 + (i + 1) * 1000
    withFrozenTime(now, () => {
      const decision = allow({ severity: 'ERROR', signature: sig, labels })
      assert(`repeat ${i + 1} is counted, not sent`, !decision.allowed)
      if (firstRepeatAt === -1) firstRepeatAt = now
      lastRepeatAt = now
    })
  }

  assert('exactly 3 full copies were sent', fullCopies === 3, `got: ${fullCopies}`)

  let pending: ReturnType<typeof peekPendingSummaries> = []
  withFrozenTime(lastRepeatAt + 1, () => {
    flushDueSummaries(true)
    pending = peekPendingSummaries()
  })
  assert('exactly one summary is pending', pending.length === 1, `got: ${pending.length}`)

  const summary = pending[0]
  assert('repeatCount is 197', summary?.repeatCount === 197, `got: ${summary?.repeatCount}`)
  assert('firstSeen is the 4th occurrence', summary?.firstSeen === new Date(firstRepeatAt).toISOString())
  assert('lastSeen is the 200th occurrence', summary?.lastSeen === new Date(lastRepeatAt).toISOString())
  assert('repeatOf is set', typeof summary?.repeatOf === 'string' && summary.repeatOf.length > 0)
  assert('the message survived', summary?.message === 'cart sync failed')
  assert('not marked sentLate — same visit', summary?.sentLate === false)

  // Slim SignatureState stores none of this — it is rebuilt from the
  // signature's own key at flush time (see parseSignatureKey).
  assert('errorType is recovered from the signature', summary?.errorType === 'Error', `got: ${summary?.errorType}`)
  assert('screen is recovered', summary?.screen === 'Checkout', `got: ${summary?.screen}`)
  assert('releaseId is recovered', summary?.releaseId === 'r1', `got: ${summary?.releaseId}`)
  assert('userId is recovered', summary?.userId === 'u1', `got: ${summary?.userId}`)
}

function testTwoReleasesOrTwoUsersGiveTwoSummaries() {
  console.log('\nTest: the same error under two releaseIds, or two userIds, gives two summaries')
  reset()
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 1 })

  const sig = signatureFor(new Error('boom'), 'Home')
  const now = 1_700_000_000_000
  let byRelease: ReturnType<typeof peekPendingSummaries> = []
  withFrozenTime(now, () => {
    // release r1/r2, same user
    for (let i = 0; i < 3; i++) allow({ severity: 'ERROR', signature: sig, labels: { releaseId: 'r1', userId: 'u1' } })
    for (let i = 0; i < 3; i++) allow({ severity: 'ERROR', signature: sig, labels: { releaseId: 'r2', userId: 'u1' } })
    flushDueSummaries(true)
    byRelease = peekPendingSummaries()
  })
  assert('two releases give two summaries', byRelease.length === 2, `got: ${byRelease.length}`)

  reset()
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 1 })
  let byUser: ReturnType<typeof peekPendingSummaries> = []
  withFrozenTime(now, () => {
    for (let i = 0; i < 3; i++) allow({ severity: 'ERROR', signature: sig, labels: { releaseId: 'r1', userId: 'u1' } })
    for (let i = 0; i < 3; i++) allow({ severity: 'ERROR', signature: sig, labels: { releaseId: 'r1', userId: 'u2' } })
    flushDueSummaries(true)
    byUser = peekPendingSummaries()
  })
  assert('two users give two summaries', byUser.length === 2, `got: ${byUser.length}`)
}

function testSummarySentOnceAnHourOrWhenForced() {
  console.log('\nTest: a summary is not due before summaryIntervalMinutes, unless forced')
  reset()
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 1, summaryIntervalMinutes: 60 })

  const sig = signatureFor(new Error('slow'), 'Checkout')
  const t0 = 1_700_000_000_000
  withFrozenTime(t0, () => {
    allow({ severity: 'WARNING', signature: sig })
    allow({ severity: 'WARNING', signature: sig }) // repeat #1
  })

  let notYetDue = -1
  withFrozenTime(t0 + 59 * 60_000, () => {
    flushDueSummaries()
    notYetDue = peekPendingSummaries().length
  })
  assert('not due yet at 59 minutes', notYetDue === 0, `got: ${notYetDue}`)

  withFrozenTime(t0 + 59 * 60_000, () => {
    allow({ severity: 'WARNING', signature: sig }) // repeat #2, keeps firstSeen
  })
  let due = -1
  withFrozenTime(t0 + 61 * 60_000, () => {
    flushDueSummaries()
    due = peekPendingSummaries().length
  })
  assert('due at 61 minutes from the first repeat', due === 1, `got: ${due}`)
}

// --- Pending summaries survive the tab closing ---

function testPendingSummarySurvivesAndIsMarkedSentLate() {
  console.log('\nTest: a summary written in one visit is sent by the next, marked sentLate')
  reset()
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 1 })

  const sig = signatureFor(new Error('late'), 'Home')
  const t0 = 1_700_000_000_000
  withFrozenTime(t0, () => {
    allow({ severity: 'WARNING', signature: sig })
    allow({ severity: 'WARNING', signature: sig })
    flushDueSummaries(true)
  })

  // Simulate the tab closing and a new one opening: sessionStorage is gone
  // and this session gets a new identity, but the localStorage queue is
  // untouched — exactly what resetRateLimiter is for in tests.
  resetRateLimiter()

  let pending: ReturnType<typeof peekPendingSummaries> = []
  withFrozenTime(t0 + 60_000, () => {
    pending = peekPendingSummaries()
  })
  assert('the summary survived', pending.length === 1, `got: ${pending.length}`)
  assert('it is marked sentLate', pending[0]?.sentLate === true)
}

function testOldSummaryIsDeletedNotSent() {
  console.log('\nTest: a summary older than summaryMaxAgeDays is deleted, not sent')
  reset()
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 1, summaryMaxAgeDays: 7 })

  const sig = signatureFor(new Error('stale'), 'Home')
  const t0 = 1_700_000_000_000
  withFrozenTime(t0, () => {
    allow({ severity: 'WARNING', signature: sig })
    allow({ severity: 'WARNING', signature: sig })
    flushDueSummaries(true)
  })

  withFrozenTime(t0 + 8 * 24 * 60 * 60 * 1000, () => {
    const pending = peekPendingSummaries()
    assert('the stale summary was not sent', pending.length === 0, `got: ${pending.length}`)
  })
}

function testMaxPendingSummariesKeepsTheNewest() {
  console.log('\nTest: more than maxPendingSummaries keeps the newest')
  reset()
  configureRateLimiter({ burstLimit: 5000, duplicateLimit: 1, maxPendingSummaries: 3 })

  const t0 = 1_700_000_000_000
  for (let n = 0; n < 5; n++) {
    const sig = signatureFor(new Error(`err-${n}`), 'Home')
    withFrozenTime(t0 + n * 60_000, () => {
      allow({ severity: 'WARNING', signature: sig })
      allow({ severity: 'WARNING', signature: sig })
      flushDueSummaries(true)
    })
  }

  let pending: ReturnType<typeof peekPendingSummaries> = []
  withFrozenTime(t0 + 5 * 60_000, () => {
    pending = peekPendingSummaries()
  })
  assert('only the cap is kept', pending.length === 3, `got: ${pending.length}`)
  const messages = pending.map((p) => p.message).sort()
  assert('the newest three survive', JSON.stringify(messages) === JSON.stringify(['err-2', 'err-3', 'err-4']), messages.join(','))
}

// --- Config and reset ---

function testConfigureMerges() {
  console.log('\nTest: configureRateLimiter merges, it does not replace')
  reset()
  configureRateLimiter({ duplicateLimit: 2 })
  configureRateLimiter({ burstLimit: 10 })    // only burstLimit

  const sig = signatureFor(new Error('dupe'), 'Home')
  allow({ severity: 'ERROR', signature: sig }); allow({ severity: 'ERROR', signature: sig })
  assert('the earlier duplicateLimit of 2 survived', !allow({ severity: 'ERROR', signature: sig }).allowed)

  for (let i = 0; i < 8; i++) allow({ severity: 'INFO' })
  assert('the new session limit applies', !allow({ severity: 'INFO' }).allowed)
}

function testCustomStorageKey() {
  console.log('\nTest: a custom storage key is honoured')
  reset()
  configureRateLimiter({ storageKey: 'custom_key' })
  resetRateLimiter()

  allow({ severity: 'INFO' })
  assert('state lands under the custom key', JSON.parse(sessionStorageStub.peek('custom_key')!).available === 49)
  assert('the default key is untouched', sessionStorageStub.peek(STORAGE_KEY) === null)

  configureRateLimiter({ storageKey: STORAGE_KEY })
}

function testResetClearsState() {
  console.log('\nTest: resetRateLimiter clears the session')
  reset()
  configureRateLimiter({ burstLimit: 2, reservedForErrors: 0 })

  allow({ severity: 'INFO' }); allow({ severity: 'INFO' })
  assert('the limit is reached', !allow({ severity: 'INFO' }).allowed)

  resetRateLimiter()
  assert('reset clears the stored state', storedState() === null)
  assert('logging is allowed again', allow({ severity: 'INFO' }).allowed)
}

function testBeforeUnloadListenerIsGone() {
  console.log('\nTest: there is no beforeunload reset any more — the budget is meant to survive a reload')
  assert('no beforeunload listener was registered', listenerCount('beforeunload') === 0)
}

// --- Storage failure ---

function testStorageFailureIsNonFatal() {
  console.log('\nTest: a broken sessionStorage does not break logging')
  reset()
  sessionStorageStub.failing = true

  let threw = false
  try {
    assert('allow() falls back to permitting the log', allow({ severity: 'INFO' }).allowed)
    assert('a signed log is permitted too', allow({ severity: 'ERROR', signature: signatureFor(new Error('x'), 'Home') }).allowed)
    resetRateLimiter()
  } catch {
    threw = true
  }
  assert('no error escapes to the caller', !threw)

  sessionStorageStub.failing = false
}

function testLocalStorageFailureIsNonFatal() {
  console.log('\nTest: a broken localStorage does not break flushing or taking summaries')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })
  const sig = signatureFor(new Error('boom'), 'Home')
  allow({ severity: 'WARNING', signature: sig })
  allow({ severity: 'WARNING', signature: sig })

  localStorageStub.failing = true
  let threw = false
  try {
    flushDueSummaries(true)
    assert('no summaries could be taken while storage is blocked', peekPendingSummaries().length === 0)
  } catch {
    threw = true
  }
  assert('no error escapes to the caller', !threw)
  localStorageStub.failing = false
}

// --- Runner ---

function run() {
  testSessionLimit()
  testEachAllowCostsExactlyOne()
  testRefusedLogsCostNothing()
  testBudgetRefillsOverTime()
  testReloadDoesNotResetTheBudget()
  testErrorReserve()
  testReserveIsByRank()
  testFractionalRechargeDoesNotBreachTheReserve()
  testSignatureSurvivesColonsAndPipes()
  testDuplicateSuppression()
  testUnsignedLogsAreNeverSuppressedAsDuplicates()
  testSuppressionIsAvailableToAnySeverity()
  testSignatureIsScopedToContext()
  testStringErrorsAreSupported()
  testSessionLimitOutranksDuplicate()
  testSignatureMapIsBounded()
  testTwoHundredCopiesSendThreeFullEntriesAndOneSummary()
  testTwoReleasesOrTwoUsersGiveTwoSummaries()
  testSummarySentOnceAnHourOrWhenForced()
  testPendingSummarySurvivesAndIsMarkedSentLate()
  testOldSummaryIsDeletedNotSent()
  testMaxPendingSummariesKeepsTheNewest()
  testConfigureMerges()
  testCustomStorageKey()
  testResetClearsState()
  testBeforeUnloadListenerIsGone()
  testStorageFailureIsNonFatal()
  testLocalStorageFailureIsNonFatal()

  reportResults()
}

run()
