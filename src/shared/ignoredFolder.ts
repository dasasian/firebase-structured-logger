import * as fs from 'fs'
import * as path from 'path'

/**
 * Node only: imports `fs`, so no file under `src/client` may import it.
 * Creates `folder` and, only if it is missing, `folder/.gitignore` holding `*`, so the
 * folder keeps itself out of git. An existing `.gitignore` is never overwritten.
 */
export function makeSelfIgnoringFolder(folder: string): void {
  fs.mkdirSync(folder, { recursive: true })
  try {
    fs.writeFileSync(path.join(folder, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}
