/**
 * No source file imports an optional peer at module load.
 *
 * `firebase`, `firebase-functions` and `firebase-admin` are all optional peers, and the
 * package has to run without them: the browser half posts to any endpoint, and
 * `createHttpLogHandler` exists for a backend that is not Cloud Functions and may not be
 * Firebase at all. Two top-level imports broke that anyway (#39) — `firebase-functions`
 * in logger.ts and logHandler.ts, then `firebase-admin/storage` in sourceMapCache.ts,
 * which a check for firebase-functions alone did not see. Where a peer is used it is
 * loaded lazily, in a named loader at the top of the file (see CLAUDE.md).
 *
 * A source check rather than a runtime one on purpose. The peers are installed in this
 * repo's devDependencies, so "load it without them" cannot be staged under the other
 * suites. `npm run smoke:install` does the runtime version against the packed tarball.
 * `import type` is fine — it erases.
 *
 * Run: npx tsx tests/loadsWithoutOptionalPeers.ts
 */

import * as fs from 'fs'
import * as path from 'path'
import { assert, reportResults } from './testHelpers.js'

const PEERS = ['firebase', 'firebase-functions', 'firebase-admin']
const SOURCE_DIRS = ['client', 'functions', 'shared', 'tools']

// A value import (not `import type`) from a peer or any of its subpaths.
// One statement at a time: the lazy match may not run on into the next `import`.
function valueImportOf(peer: string): RegExp {
  return new RegExp(
    `^import\\s+(?!type\\b)(?:(?!\\bimport\\b)[\\s\\S])*?\\bfrom\\s+['"]${peer}(\\/[^'"]*)?['"]`,
    'm',
  )
}

function sourceFiles(): string[] {
  return SOURCE_DIRS.flatMap((d) => {
    const dir = path.join(process.cwd(), 'src', d)
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(dir, f))
  })
}

function run() {
  console.log('\nTest: no source file imports an optional peer at module load')
  const files = sourceFiles()
  assert('there are source files to check', files.length > 0)
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8')
    const name = path.relative(path.join(process.cwd(), 'src'), file)
    for (const peer of PEERS) {
      const hit = src.match(valueImportOf(peer))
      if (hit) assert(`${name} has no top-level value import from ${peer}`, false, hit[0])
    }
  }
  assert(`${files.length} files checked against ${PEERS.join(', ')}`, true)
  reportResults()
}

run()
