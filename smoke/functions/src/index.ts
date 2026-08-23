/**
 * Smoke-test Cloud Functions.
 *
 * Deployed to a dedicated smoke project so the runner can write real logs and
 * query them back. Never published — `files` in the root package.json is
 * ["dist", "skills"], so `smoke/` stays out of the tarball.
 *
 * They depend on the PUBLISHED package, not the local build, so a run exercises
 * the artifact a consumer actually installs: the exports map, the files
 * contents, and the peer dependencies.
 *
 * All project-specific values come from the environment — see .env.example.
 * Nothing identifying is committed.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { initializeApp } from 'firebase-admin/app'
import {
  initLogger,
  createClientLogFunction,
  createClientLogHandler,
  withLogging,
  logError,
  logInfo,
  logWarn,
  type LogPayload,
} from '@dasasian/firebase-structured-logger/functions'

initializeApp()

const APP_ID = process.env.FSL_SMOKE_APP_ID ?? 'smoke-app'
const BUCKET = process.env.FSL_SMOKE_BUCKET

// The production floor defaults to WARNING. The run asserts on INFO entries
// too, so without this half of them would never be emitted — and the failure
// would look like an ingestion problem rather than a config one.
initLogger({ appId: APP_ID, minSeverity: 'DEBUG' })

const OPTS = { maxInstances: 1, cors: true }

/** Client path with the bucket resolved by default — what most consumers do. */
export const fslSmokeClient = createClientLogFunction(OPTS)

/**
 * Client path with an explicit bucket.
 *
 * What this does NOT prove: with a single bucket both functions resolve to the
 * same place, so this covers the explicit-bucketName code path, not
 * per-handler isolation. Isolation is covered deterministically in
 * tests/configureTwice.ts.
 */
export const fslSmokeClientBucket = createClientLogFunction(
  BUCKET ? { ...OPTS, bucketName: BUCKET } : OPTS,
)

/**
 * Backend path — withLogging + AsyncLocalStorage, a different route to writeLog.
 *
 * Deploying this is the only way to confirm the wrapper's returned signature
 * genuinely satisfies onCall with the real firebase-functions types and runtime.
 * A unit test drives it with a synthetic CallableRequest, which cannot settle
 * that.
 */
export const fslSmokeBackend = onCall(
  OPTS,
  withLogging(
    (request) => ({
      functionName: 'fslSmokeBackend',
      appId: APP_ID,
      labels: { smokeRunId: (request.data as { runId?: string })?.runId },
    }),
    async (request) => {
      const { runId } = (request.data ?? {}) as { runId?: string }
      if (!runId) throw new HttpsError('invalid-argument', 'runId is required')

      logInfo('[fsl-verify] backend info', { errorType: 'fsl-verify' }, { via: 'logInfo' })
      logWarn('[fsl-verify] backend warning', { errorType: 'fsl-verify' })
      logError(new Error('[fsl-verify] backend error'), { errorType: 'fsl-verify' }, { via: 'logError' })

      return { ok: true, runId }
    },
  ),
)

/**
 * Feedback path, behind a WARNING floor — the half of the exemption that only
 * production can prove.
 *
 * Deployed functions do not share instances, so this one owning a WARNING floor
 * cannot affect the others. That floor is the point: it is what a real consumer
 * runs, and it is what silently swallowed feedback when only the CLIENT floor
 * had been exempted. The runner sends a plain NOTICE and a feedback NOTICE
 * through here and asserts that exactly one survives.
 */
export const fslSmokeFeedback = onCall<LogPayload, void>(OPTS, async (request) => {
  initLogger({ appId: APP_ID, minSeverity: 'WARNING' })
  return createClientLogHandler({})(request)
})
