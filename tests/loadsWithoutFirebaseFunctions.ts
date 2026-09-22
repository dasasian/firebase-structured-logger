/**
 * `/functions` must load without firebase-functions installed.
 *
 * createHttpLogHandler (0.7.0) exists for a backend that is not Cloud Functions, and that
 * backend does not have `firebase-functions` — it is an optional peer. Two top-level
 * imports made the entry point die on `require` there anyway: `firebase-functions/logger`
 * in logger.ts and `firebase-functions/v2/https` in logHandler.ts. Both are resolved on
 * first use now, and this pins that.
 *
 * It is a source check rather than a runtime one on purpose. The package is installed in
 * this repo's devDependencies, so "load it without firebase-functions" cannot be staged
 * without uninstalling it under the other suites. What can be asserted, cheaply and
 * without a fixture, is the shape that caused the failure: a value import from
 * `firebase-functions` at the top of a `/functions` source file. `import type` is fine —
 * it erases.
 *
 * Run: npx tsx tests/loadsWithoutFirebaseFunctions.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { assert, reportResults } from './testHelpers.js'

const dir = path.join(process.cwd(), 'src', 'functions')
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))

// A value import (not `import type`) from any firebase-functions entry point.
// One statement at a time: the lazy match may not run on into the next `import`.
const VALUE_IMPORT =
  /^import\s+(?!type\b)(?:(?!\bimport\b)[\s\S])*?\bfrom\s+['"]firebase-functions(\/[^'"]*)?['"]/m

function run() {
  console.log('\nTest: no /functions source imports firebase-functions at module load')
  assert('there are source files to check', files.length > 0)
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf-8')
    const hit = src.match(VALUE_IMPORT)
    assert(`${f} has no top-level value import from firebase-functions`, hit === null, hit?.[0])
  }
  reportResults()
}

run()
