const SAFE_BARE_TOKEN = /^[A-Za-z0-9_/.:=-]+$/

export interface QuoteShellArgvOptions {
  readonly bareSafe?: boolean
}

export function quoteShellArg(value: string, opts: QuoteShellArgvOptions = {}): string {
  if (opts.bareSafe && SAFE_BARE_TOKEN.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function quoteShellArgv(argv: readonly string[], opts: QuoteShellArgvOptions = {}): string {
  return argv.map((arg) => quoteShellArg(arg, opts)).join(" ")
}
