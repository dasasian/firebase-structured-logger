/**
 * Reading facts out of an installed `node_modules` tree.
 *
 * Shared by `fsl doctor` (duplicate Storage copies, installed peer versions) and
 * `smoke/install.ts` (the same duplicate-copy check, against a real install). Moved
 * here so the two do not carry their own copies of the same walker — doctor's fake
 * projects and the smoke install are different trees, but "find every copy of this
 * package under here" is the same question in both.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface InstalledPackage {
  /** Absolute path to the package directory (the one containing its `package.json`). */
  dir: string
  version: string
}

/**
 * Read `<dir>/package.json`, distinguishing "not installed" from "installed but
 * unreadable" — doctor treats the second as `could-not-check`, never as absent.
 */
export function readPackageJson(dir: string): { ok: true; pkg: Record<string, unknown> } | { ok: false; reason: 'missing' | 'malformed' } {
  const file = path.join(dir, 'package.json')
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' }
  try {
    return { ok: true, pkg: JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown> }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

/**
 * Every installed copy of `packageName` under `rootDir/node_modules`, including
 * copies nested under another package's own `node_modules` (npm dedupe leaves
 * exactly one; an un-deduped tree can have several).
 */
export function findPackageCopies(rootDir: string, packageName: string): InstalledPackage[] {
  const found: InstalledPackage[] = []
  const targetSuffix = path.join(...packageName.split('/'))

  const walk = (nodeModules: string) => {
    if (!fs.existsSync(nodeModules)) return
    for (const entry of safeReaddir(nodeModules)) {
      if (entry.startsWith('.')) continue
      const entryDir = path.join(nodeModules, entry)
      const pkgDirs = entry.startsWith('@')
        ? safeReaddir(entryDir).map((n) => path.join(entryDir, n))
        : [entryDir]
      for (const pkgDir of pkgDirs) {
        if (pkgDir.endsWith(targetSuffix)) {
          const read = readPackageJson(pkgDir)
          if (read.ok && typeof read.pkg.version === 'string') {
            found.push({ dir: pkgDir, version: read.pkg.version })
          }
        }
        walk(path.join(pkgDir, 'node_modules'))
      }
    }
  }

  walk(path.join(rootDir, 'node_modules'))
  return found
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The version of `packageName` installed directly under one of `searchDirs`,
 * checked in order — the first directory with a top-level copy wins. Used to
 * resolve peers (`firebase`, `firebase-admin`, `firebase-functions`), which are
 * singletons in a working tree, unlike `@google-cloud/storage`.
 */
export function findTopLevelVersion(searchDirs: string[], packageName: string): string | undefined {
  for (const dir of searchDirs) {
    const pkgDir = path.join(dir, 'node_modules', ...packageName.split('/'))
    const read = readPackageJson(pkgDir)
    if (read.ok && typeof read.pkg.version === 'string') return read.pkg.version
  }
  return undefined
}
