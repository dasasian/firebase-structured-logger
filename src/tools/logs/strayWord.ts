import { ATTACHMENT_FLAGS, QUERY_FLAGS, SCHEMA_FLAGS, UsageError, parseFlags, type ParsedFlags } from './flags.js'

const SUBCOMMAND_FLAGS = { schema: SCHEMA_FLAGS, attachments: ATTACHMENT_FLAGS }

const EVERY_FLAG = { ...QUERY_FLAGS, ...SCHEMA_FLAGS, ...ATTACHMENT_FLAGS }

const SUBCOMMAND_EXAMPLE = 'fsl logs schema --local'

function isSubcommand(word: string): word is keyof typeof SUBCOMMAND_FLAGS {
  return word in SUBCOMMAND_FLAGS
}

function carriedSwitches(flags: ParsedFlags, accepted: Record<string, unknown>): string[] {
  return [...flags.switches].filter((name) => name in accepted).map((name) => `--${name}`)
}

/** The query takes flags only: any word is an error, and `schema` or `attachments` in the wrong place gets the correct form. */
export function refuseStrayWordInQuery(flags: ParsedFlags): void {
  const [word, ...others] = flags.positionals
  if (word === undefined) return
  if (isSubcommand(word)) {
    const form = ['fsl logs', word, ...others, ...carriedSwitches(flags, SUBCOMMAND_FLAGS[word])].join(' ')
    throw new UsageError(`"${word}" is a sub-command and comes right after logs.\nCorrect form: ${form}`)
  }
  throw new UsageError(`Unknown word "${word}". A query is made of flags; the sub-commands are schema and attachments, and they come right after logs.\nExample: ${SUBCOMMAND_EXAMPLE}`)
}

/** `fsl logs schema` takes flags only. `--add name [meaning]` is read before this, so a word left over is a meaning that needs quotes. */
export function refuseStrayWordInSchema(flags: ParsedFlags): void {
  const [word] = flags.positionals
  if (word === undefined) return
  throw new UsageError(`Unknown word "${word}" after schema. It takes flags only; a label's meaning goes in quotes.\nExample: fsl logs schema --add venueId "the venue the order belongs to"`)
}

/** `fsl logs attachments` takes one logId and flags. */
export function refuseStrayWordInAttachments(flags: ParsedFlags): void {
  const [, word] = flags.positionals
  if (word === undefined) return
  throw new UsageError(`Unknown word "${word}" after the logId. attachments takes one logId and flags.\nExample: fsl logs attachments 01JAXYZ...`)
}

function parseEveryFlag(argv: string[]): ParsedFlags | undefined {
  try {
    return parseFlags(argv, EVERY_FLAG)
  } catch {
    return undefined
  }
}

/** Parses the query's flags. A flag of `schema` or `attachments` beside a sub-command word in the wrong place is answered with the correct form, not with the unknown-flag error. */
export function parseQueryFlags(argv: string[]): ParsedFlags {
  try {
    return parseFlags(argv, QUERY_FLAGS)
  } catch (unknownFlag) {
    const everything = parseEveryFlag(argv)
    if (everything?.positionals[0] !== undefined && isSubcommand(everything.positionals[0])) refuseStrayWordInQuery(everything)
    throw unknownFlag
  }
}
