/**
 * Build the environment seen by a child of an embedded terminal.
 * The embedded parser is not the outer emulator, so its identity must not
 * leak through and trigger emulator-specific protocol choices in children.
 *
 * The scrub covers the whole ancestor-identity namespace, not just
 * TERM_PROGRAM: apps with layered detection (claude-code checks
 * LC_TERMINAL, ITERM_SESSION_ID, __CFBundleIdentifier, KITTY_*, TMUX, …
 * as fallbacks) otherwise still resolve the OUTER emulator and keep
 * emitting its dialect at kobe's xterm parser. Capability variables
 * (TERM, COLORTERM, TERMINFO*) survive — they describe what the immediate
 * parser can do, which the spawn sites set explicitly.
 */

/** Exact variable names that identify an ancestor emulator or multiplexer. */
const IDENTITY_VARS = new Set([
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID", // Terminal.app / iTerm2 session
  "TERM_FEATURES", // iTerm2 capability advertisement
  "LC_TERMINAL", // iTerm2 identity (survives ssh)
  "LC_TERMINAL_VERSION",
  "__CFBundleIdentifier", // macOS ancestor app id (com.googlecode.iterm2)
  "VTE_VERSION", // GNOME VTE terminals
  "WT_SESSION", // Windows Terminal
  "WT_PROFILE_ID",
  "TMUX", // children talk to xterm-headless, not a tmux pane
  "TMUX_PANE",
  "ZELLIJ",
  "STY", // GNU screen
  "WINDOW",
])

/** Emulator-owned variable families, matched by prefix. */
const IDENTITY_PREFIXES = ["ITERM_", "KITTY_", "GHOSTTY_", "WEZTERM_", "ALACRITTY_", "KONSOLE_", "ZELLIJ_"]

/**
 * @param {Readonly<Record<string, string | undefined>>} base
 * @param {Readonly<Record<string, string | undefined>>} [overrides]
 * @returns {Record<string, string | undefined>}
 */
export function embeddedTerminalEnv(base, overrides = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (IDENTITY_VARS.has(key)) continue
    if (IDENTITY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  return { ...env, ...overrides }
}
