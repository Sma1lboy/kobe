/**
 * Build the environment seen by a child of an embedded terminal.
 * The embedded parser is not the outer emulator, so its identity must not
 * leak through and trigger emulator-specific protocol choices in children.
 *
 * @param {Readonly<Record<string, string | undefined>>} base
 * @param {Readonly<Record<string, string | undefined>>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
export function embeddedTerminalEnv(base, overrides = {}) {
  const { TERM_PROGRAM: _termProgram, TERM_PROGRAM_VERSION: _termProgramVersion, ...env } = base
  return { ...env, ...overrides }
}
