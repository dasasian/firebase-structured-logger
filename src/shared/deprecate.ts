/**
 * One console warning per renamed option, however many times it is passed.
 *
 * The 1.0 rename (#44) kept seven old names working as aliases for their new
 * ones. Each is read from a config object that some caller may hand to the
 * same function many times (see the module-scoped-state rule in CLAUDE.md —
 * `configureRateLimiter`, `initLogger` and `createClientLogHandler` all
 * qualify), so warning on every call would spam the console for a caller who
 * used the old name once and moved on with their session. Warning is keyed on
 * the (old, new) pair, not on the module, since the seven renames live across
 * three different files and a shared key space is what makes "once per
 * process" actually mean once.
 */
const warned = new Set<string>()

export function warnDeprecated(oldName: string, newName: string): void {
  const key = `${oldName}->${newName}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `[fsl] "${oldName}" is deprecated — use "${newName}" instead. It still works in 1.x and will be removed in 2.0.`,
  )
}

/** Test-only: forget every warning already issued, so a suite can assert "once" from a clean slate. */
export function resetDeprecationWarnings(): void {
  warned.clear()
}
