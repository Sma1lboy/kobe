/**
 * Shell command quoting helpers.
 *
 * Use these whenever argv values must be flattened back into a single shell
 * command string. The default is conservative (quote every argument); callers
 * that need readable launch lines can allow a small safe bare-token set.
 */

const SAFE_BARE_TOKEN = /^[A-Za-z0-9_/.:=-]+$/

export interface QuoteShellArgvOptions {
  /**
   * Leave simple argv tokens unquoted. This keeps generated launch lines easier
   * to read while still quoting spaces, quotes, and shell metacharacters.
   */
  readonly bareSafe?: boolean
}

/** Quote one value as a POSIX single-quoted shell token. */
export function quoteShellArg(value: string, opts: QuoteShellArgvOptions = {}): string {
  if (opts.bareSafe && SAFE_BARE_TOKEN.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Quote argv values and join them into one shell command line. */
export function quoteShellArgv(argv: readonly string[], opts: QuoteShellArgvOptions = {}): string {
  return argv.map((arg) => quoteShellArg(arg, opts)).join(" ")
}
