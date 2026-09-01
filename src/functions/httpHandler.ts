/**
 * Receive client logs over plain HTTP, for a backend that is not Cloud Functions
 * (#34).
 *
 * The client half was already portable — `logFunction` is any
 * `(payload) => Promise<unknown>`, and `httpsCallable()` merely happens to fit.
 * What was missing was a receiving end that does not require a callable.
 *
 * This is deliberately framework-agnostic. It reads `method`, `headers` and a
 * parsed `body`, and writes through `statusCode` / `setHeader` / `end` — the
 * Node core shapes, which Express, Fastify's compat layer and Cloud Run's raw
 * server all satisfy. Parsing the body is the caller's job (`express.json()` or
 * equivalent); reading the stream here would mean guessing at limits and
 * encodings that the host framework already has opinions about.
 */

import { ClientLogError, createClientLogHandler, type ClientLogHandlerConfig } from './logHandler'
import type { LogPayload } from '../shared/types'

/** The parts of a request this handler reads. */
export interface HttpLogRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

/** The parts of a response this handler writes. */
export interface HttpLogResponse {
  statusCode: number
  setHeader(name: string, value: string): unknown
  end(body?: string): unknown
}

export interface HttpLogHandlerConfig extends ClientLogHandlerConfig {
  /**
   * Who is allowed to POST a log.
   *
   * Required, and with no default, because the honest default does not exist. A
   * callable gets Firebase's own token check for free; an HTTP endpoint gets
   * nothing, and an open one writes to the customer's Cloud Logging bill on
   * anyone's say-so.
   *
   * This is a **gate, not an identity check**. The handler never reads
   * `request.auth` — `userId` arrives self-reported in the client's own labels
   * either way. Its job is to keep strangers out, not to establish who is
   * speaking.
   *
   * Verify a Firebase ID token:
   *
   *     import { getAuth } from 'firebase-admin/auth'
   *     authorize: async (req) => {
   *       const header = String(req.headers.authorization ?? '')
   *       if (!header.startsWith('Bearer ')) return false
   *       try { await getAuth().verifyIdToken(header.slice(7)); return true }
   *       catch { return false }
   *     }
   *
   * Pass the literal `'unauthenticated'` to open the endpoint deliberately —
   * behind a VPC, an API gateway, or IAM that already did the work. It is spelled
   * out at the call site so nobody arrives there by omission.
   */
  authorize: ((request: HttpLogRequest) => boolean | Promise<boolean>) | 'unauthenticated'

  /**
   * Value for `Access-Control-Allow-Origin`. Defaults to `*`, matching
   * `createClientLogFunction`'s `cors: true`.
   *
   * A browser cannot send credentials to a wildcard origin, so name your origins
   * if the gate above reads a cookie. A bearer token in a header is unaffected.
   */
  allowOrigin?: string
}

const STATUS: Record<ClientLogError['code'], number> = {
  'invalid-argument': 400,
  internal: 500,
}

function send(res: HttpLogResponse, status: number, body?: Record<string, string>): void {
  res.statusCode = status
  if (body) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  } else {
    res.end()
  }
}

/**
 * Build a request handler that receives `LogPayload` over HTTP.
 *
 *     import express from 'express'
 *     import { createHttpLogHandler } from '@dasasian/firebase-structured-logger/functions'
 *
 *     const app = express()
 *     app.use(express.json({ limit: '10mb' }))   // attachments ride in the body
 *     app.post('/log', createHttpLogHandler({ bucketName, authorize }))
 *
 * On the client, point `logFunction` at it:
 *
 *     logFunction: async (payload) => {
 *       const res = await fetch('/log', {
 *         method: 'POST',
 *         headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` },
 *         body: JSON.stringify(payload),
 *       })
 *       if (!res.ok) throw new Error(`log rejected: ${res.status}`)
 *     }
 */
export function createHttpLogHandler(
  config: HttpLogHandlerConfig,
): (req: HttpLogRequest, res: HttpLogResponse) => Promise<void> {
  const handler = createClientLogHandler(config)
  const allowOrigin = config.allowOrigin ?? '*'

  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin)
    res.setHeader('Vary', 'Origin')

    // Preflight. The client sends Content-Type and usually Authorization, both
    // of which make the request non-simple.
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.setHeader('Access-Control-Max-Age', '3600')
      return send(res, 204)
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS')
      return send(res, 405, { error: 'Use POST' })
    }

    if (config.authorize !== 'unauthenticated') {
      let allowed = false
      try {
        allowed = await config.authorize(req)
      } catch (err) {
        // A gate that threw is a gate that did not pass. Say so on the server
        // and tell the caller nothing about why.
        console.warn('[fsl] authorize() threw; rejecting the request:', err)
      }
      if (!allowed) return send(res, 401, { error: 'Unauthorized' })
    }

    if (req.body === null || typeof req.body !== 'object') {
      // Almost always a missing body parser rather than a bad client, and that
      // is a five-minute fix once someone says it out loud.
      return send(res, 400, {
        error: 'Expected a parsed JSON body. Is express.json() (or equivalent) mounted before this handler?',
      })
    }

    try {
      await handler({ data: req.body as LogPayload })
      return send(res, 204)
    } catch (err) {
      if (err instanceof ClientLogError) {
        // 'internal' has already been logged with its cause by the handler.
        return send(res, STATUS[err.code], { error: err.message })
      }
      console.error('[fsl] Unhandled error in the HTTP log handler:', err)
      return send(res, 500, { error: 'Failed to process log' })
    }
  }
}
