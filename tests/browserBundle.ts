/**
 * The client's production floor, as a browser actually runs it.
 *
 * `tests/logger.ts` pins the Node half: NODE_ENV=production in a process that has
 * `process`. The browser half is different — the bundler folds `process.env.NODE_ENV` to a
 * literal, and `process` itself does not exist. For a long time the source guarded on
 * `typeof process`, which the fold leaves alone, so every browser build defaulted to DEBUG
 * in production (seen in a real Vite bundle as `typeof process<"u"?"WARNING":"DEBUG"`).
 * A Node test cannot see that: Node has `process`.
 *
 * So this bundles the client logger with esbuild — the same fold Vite applies — and runs
 * the bundle in a `vm` context with no `process` in it.
 *
 * Run: npx tsx tests/browserBundle.ts
 */

import * as path from 'path'
import * as vm from 'vm'
import { build } from 'esbuild'
import type { LogPayload } from '../src/shared/types.js'
import { assert, reportResults } from './testHelpers.js'

interface BundledLogger {
  info(message: string): void
  warning(message: string): void
}

interface BundleExports {
  initLogger(config: {
    appId: string
    releaseId: string
    logFunction: (data: LogPayload) => Promise<unknown>
  }): BundledLogger
}

async function bundle(define: Record<string, string>): Promise<string> {
  const result = await build({
    stdin: {
      contents: "export { initLogger } from './src/client/logger'",
      resolveDir: path.join(process.cwd()),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: 'fsl',
    platform: 'browser',
    define,
    write: false,
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

/** A browser-shaped global: storage and a UA, and deliberately no `process`. */
function browserContext(): vm.Context {
  const store = new Map<string, string>()
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  return vm.createContext({
    console,
    setTimeout,
    sessionStorage,
    navigator: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140.0' },
  })
}

async function sentSeverities(code: string): Promise<string[]> {
  const context = browserContext()
  assert('the sandbox has no process', vm.runInContext('typeof process', context) === 'undefined')
  vm.runInContext(code, context)
  const { initLogger } = vm.runInContext('fsl', context) as BundleExports

  const sent: string[] = []
  const logger = initLogger({
    appId: 'bundle-test',
    releaseId: 'r1',
    logFunction: async (data) => void sent.push(data.severity),
  })
  logger.info('routine')
  logger.warning('worth hearing')
  await new Promise((r) => setTimeout(r, 0))
  return sent
}

async function testProductionBundleFloorIsWarning() {
  console.log('\nTest: a production bundle, run without process, drops INFO and sends WARNING')
  const code = await bundle({ 'process.env.NODE_ENV': '"production"' })
  assert('the bundle does not test for process', !code.includes('typeof process'))
  const sent = await sentSeverities(code)
  assert('INFO is dropped', !sent.includes('INFO'), JSON.stringify(sent))
  assert('WARNING is sent', sent.includes('WARNING'), JSON.stringify(sent))
}

async function testUnfoldedBundleFallsBackToDebug() {
  console.log('\nTest: a bundle with no fold, run without process, loads and defaults to DEBUG')
  const sent = await sentSeverities(await bundle({}))
  assert('INFO is sent', sent.includes('INFO'), JSON.stringify(sent))
  assert('WARNING is sent', sent.includes('WARNING'), JSON.stringify(sent))
}

async function run() {
  await testProductionBundleFloorIsWarning()
  await testUnfoldedBundleFallsBackToDebug()
  reportResults()
}

run()
