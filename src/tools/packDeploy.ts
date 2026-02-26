import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

// __dirname resolves symlinks, so when consumed via file: reference this points
// to the real firebase-structured-logger directory, not node_modules.
const packageRoot = path.join(__dirname, '..', '..')

interface PackOptions {
  functionsDir: string
}

interface RestoreManifest {
  originalRef: string
  tgzFileName: string
}

function readPackageJson(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
}

function writePackageJson(dir: string, pkg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

function findFslDep(pkg: Record<string, unknown>): { field: string; ref: string } | null {
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field] as Record<string, string> | undefined
    if (deps?.['firebase-structured-logger']) {
      return { field, ref: deps['firebase-structured-logger'] }
    }
  }
  return null
}

/**
 * Build + pack firebase-structured-logger, copy tgz to functions/vendor/,
 * and patch functions/package.json to reference it. Call before firebase deploy.
 */
export async function pack(options: PackOptions): Promise<void> {
  const functionsDir = path.resolve(process.cwd(), options.functionsDir)
  const vendorDir = path.join(functionsDir, 'vendor')
  const manifestPath = path.join(vendorDir, '.fsl-restore.json')

  // 1. Build
  console.log('[fsl] Building firebase-structured-logger...')
  execSync('npm run build', { cwd: packageRoot, stdio: 'inherit' })

  // 2. Pack — use --json for reliable filename parsing
  console.log('[fsl] Packing...')
  const packOutput = execSync('npm pack --json', { cwd: packageRoot, encoding: 'utf-8' })
  const [{ filename: baseTgzFileName }] = JSON.parse(packOutput) as [{ filename: string }]
  const tgzSource = path.join(packageRoot, baseTgzFileName)

  // Use a unique filename per pack to prevent Cloud Build from caching stale tarballs.
  // Derive a short ID from the app's git HEAD (falls back to timestamp).
  let uniqueId: string
  try {
    uniqueId = execSync('git rev-parse --short HEAD', { cwd: functionsDir, encoding: 'utf-8' }).trim()
  } catch {
    uniqueId = Date.now().toString(36)
  }
  const tgzFileName = baseTgzFileName.replace(/\.tgz$/, `-${uniqueId}.tgz`)

  // 3. Copy to functions/vendor/ (remove any previous fsl tarballs first)
  fs.mkdirSync(vendorDir, { recursive: true })
  for (const f of fs.readdirSync(vendorDir)) {
    if (f.startsWith('firebase-structured-logger-') && f.endsWith('.tgz')) {
      fs.unlinkSync(path.join(vendorDir, f))
    }
  }
  const tgzDest = path.join(vendorDir, tgzFileName)
  fs.copyFileSync(tgzSource, tgzDest)
  fs.unlinkSync(tgzSource)
  console.log(`[fsl] Copied ${tgzFileName} → functions/vendor/`)

  // 4. Patch functions/package.json
  const pkg = readPackageJson(functionsDir)
  const existing = findFslDep(pkg)

  if (!existing) {
    console.error('[fsl] firebase-structured-logger not found in functions/package.json')
    process.exit(1)
  }

  const manifest: RestoreManifest = { originalRef: existing.ref, tgzFileName }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  ;(pkg[existing.field] as Record<string, string>)['firebase-structured-logger'] =
    `file:./vendor/${tgzFileName}`
  writePackageJson(functionsDir, pkg)

  // 5. npm install to lock in the tgz
  console.log('[fsl] Installing...')
  execSync('npm install', { cwd: functionsDir, stdio: 'inherit' })

  console.log('[fsl] Pack complete — ready to deploy.')
}

/**
 * Restore functions/package.json to its original file: reference.
 * Call after firebase deploy (e.g. in postdeploy script).
 */
export async function packRestore(options: PackOptions): Promise<void> {
  const functionsDir = path.resolve(process.cwd(), options.functionsDir)
  const vendorDir = path.join(functionsDir, 'vendor')
  const manifestPath = path.join(vendorDir, '.fsl-restore.json')

  if (!fs.existsSync(manifestPath)) {
    console.log('[fsl] No restore manifest found — nothing to restore.')
    return
  }

  const { originalRef, tgzFileName }: RestoreManifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf-8'),
  )

  // 1. Restore package.json
  const pkg = readPackageJson(functionsDir)
  const existing = findFslDep(pkg)
  if (existing) {
    ;(pkg[existing.field] as Record<string, string>)['firebase-structured-logger'] = originalRef
    writePackageJson(functionsDir, pkg)
  }

  // 2. Remove tgz + manifest
  const tgzPath = path.join(vendorDir, tgzFileName)
  if (fs.existsSync(tgzPath)) fs.unlinkSync(tgzPath)
  fs.unlinkSync(manifestPath)

  // 3. npm install to restore symlink
  console.log('[fsl] Restoring...')
  execSync('npm install', { cwd: functionsDir, stdio: 'inherit' })

  console.log('[fsl] Restore complete.')
}
