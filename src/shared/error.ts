import type { ErrorPayload } from './types'

/** Coerce an unknown thrown value into an Error. */
export function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

/** Build the wire-shape error payload logged under `jsonPayload.error`. */
export function toErrorPayload(error: Error): ErrorPayload {
  return {
    message: error.message,
    stack: error.stack,
    name: error.name,
    cause: error.cause != null ? String(error.cause) : undefined,
  }
}
