import { embeddedTerminalEnv } from "@sma1lboy/kobe-daemon/daemon/pty-env"

/**
 * Environment policy for browser-backed PTY children.
 *
 * @param {Readonly<Record<string, string | undefined>>} [base]
 * @returns {Record<string, string | undefined>}
 */
export function ptyEnv(base = process.env) {
  const { NO_COLOR: _noColor, ...env } = embeddedTerminalEnv(base)
  // CI/launcher shells may suppress color, but this child owns a real PTY.
  env.CLICOLOR = env.CLICOLOR ?? "1"
  env.COLORTERM = env.COLORTERM || "truecolor"
  return env
}
