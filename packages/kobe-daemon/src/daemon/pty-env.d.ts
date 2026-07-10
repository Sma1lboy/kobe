export type TerminalEnvironment = Readonly<Record<string, string | undefined>>

export declare function embeddedTerminalEnv(
  base: TerminalEnvironment,
  overrides?: TerminalEnvironment,
): Record<string, string | undefined>
