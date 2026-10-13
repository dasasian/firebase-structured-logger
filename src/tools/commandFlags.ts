import { UsageError } from './logs/flags.js'

export interface CommandFlagSet {
  valueFlags: readonly string[]
  switches: readonly string[]
  example: string
}

export interface CommandFlags {
  values: Record<string, string>
  switches: Set<string>
}

export const UPLOAD_FLAGS: CommandFlagSet = {
  valueFlags: ['bucket', 'backend', 'functions', 'release', 'dist', 'prefix'],
  switches: ['embed-sourcemaps'],
  example: 'fsl upload-sourcemaps --bucket my-bucket --backend functions --release abc123',
}

export const DOCTOR_FLAGS: CommandFlagSet = {
  valueFlags: ['backend', 'dist'],
  switches: ['strict', 'json'],
  example: 'fsl doctor --backend backend --dist frontend/dist',
}

export const INSTALL_SKILLS_FLAGS: CommandFlagSet = {
  valueFlags: [],
  switches: ['global', 'force'],
  example: 'fsl install-skills --global',
}

function looksLikeFlag(token: string | undefined): boolean {
  return token !== undefined && token.startsWith('--')
}

/**
 * Reads `--name=value` and `--name value` for the flags in `set.valueFlags`, and `--name` for
 * `set.switches`, which never takes the next word. A value flag with no value throws a
 * `UsageError` that shows `set.example`. Any other flag or word is ignored.
 */
export function parseCommandFlags(argv: string[], set: CommandFlagSet): CommandFlags {
  const parsed: CommandFlags = { values: {}, switches: new Set() }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!looksLikeFlag(token)) continue
    const equals = token.indexOf('=')
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals)
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1)
    if (set.switches.includes(name)) {
      if (inlineValue === undefined || inlineValue === 'true') parsed.switches.add(name)
      continue
    }
    if (!set.valueFlags.includes(name)) continue
    const nextToken = argv[index + 1]
    const takesNext = inlineValue === undefined && nextToken !== undefined && !looksLikeFlag(nextToken)
    const value = inlineValue ?? (takesNext ? nextToken : undefined)
    if (value === undefined) throw new UsageError(`--${name} needs a value.\nExample: ${set.example}`)
    if (takesNext) index++
    parsed.values[name] = value
  }
  return parsed
}
