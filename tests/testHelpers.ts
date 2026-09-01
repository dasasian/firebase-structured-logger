/**
 * Shared helpers for the tsx test suites.
 * Each suite runs in its own process, so the pass/fail counters are module state.
 */

import fs from 'fs'
import path from 'path'
import type { CallableRequest } from 'firebase-functions/v2/https'
import type { LogPayload } from '../src/shared/types.js'
import { LOG_FILENAME } from '../src/functions/logger.js'

let passed = 0
let failed = 0

export function assert(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`)
    failed++
  }
}

/** Print the tally and exit non-zero if anything failed. */
export function reportResults(): void {
  console.log(`\n${'─'.repeat(40)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

function logFile(logDir: string): string {
  return path.join(logDir, LOG_FILENAME)
}

/** Read the last JSONL entry the emulator-mode logger wrote to `logDir`. */
/**
 * One entry as the emulator writes it to dev.jsonl.
 *
 * Typed rather than left as Record<string, unknown>: suites read `.message` and
 * `.labels.userId` off this constantly, and an opaque record makes every one of
 * those an untyped hop that the typecheck cannot follow (#38).
 */
export interface LoggedEntry {
  timestamp?: string
  severity?: string
  message?: string
  labels?: Record<string, string | undefined>
  jsonPayload?: Record<string, unknown>
  functionName?: string
  requestId?: string
  [key: string]: unknown
}

export function readLastEntry(logDir: string): LoggedEntry | undefined {
  const file = logFile(logDir)
  if (!fs.existsSync(file)) return undefined
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
  return lines.length ? JSON.parse(lines[lines.length - 1]) : undefined
}

export function clearLog(logDir: string): void {
  const file = logFile(logDir)
  if (fs.existsSync(file)) fs.writeFileSync(file, '')
}

/** Minimal CallableRequest stub for driving handlers without the HTTP layer. */
export function makeRequest(data: LogPayload): CallableRequest<LogPayload> {
  return { data, auth: undefined, rawRequest: {} } as unknown as CallableRequest<LogPayload>
}
