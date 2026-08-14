/**
 * Isolated environment for the README/docs capture stack ("hero" fixture).
 *
 * Same ground-truth path as `visual:serve` (fixed browser `/harness` →
 * xterm.js → PTY sidecar → real OpenTUI), but pointed at a RICHER throwaway
 * home: a realistic repo, several tasks, and REAL engine sessions, because
 * the barren visual fixture photographs as an empty workspace.
 *
 * One deliberate difference from `visual-fixture.ts`: `HOME` stays the
 * operator's own. The engine under capture is the real `claude` binary and it
 * reads its credentials from `$HOME/.claude`; a redirected home would
 * photograph a login screen. Rove's OWN state is still fully isolated —
 * `ROVE_HOME_DIR` (tasks, worktrees, daemon socket) and `XDG_CONFIG_HOME`
 * (settings) both land under `.scratch/hero/`, and every inherited
 * daemon/task override is scrubbed so a capture run from inside a Rove task
 * can never reach the owner's live daemon.
 */

import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")
export const KOBE_DIR: string = join(REPO_ROOT, "packages", "kobe")
export const HERO_CLI: string = join(KOBE_DIR, "dist", "cli", "rove.js")

export const HERO_PORT_BASE = Number.parseInt(process.env.HERO_PORT_BASE ?? "5323", 10)
export const HERO_WEB_PORT = HERO_PORT_BASE
export const HERO_DAEMON_PORT = HERO_PORT_BASE + 1
export const HERO_PTY_PORT = HERO_PORT_BASE + 2

export const HERO_ROOT: string = join(REPO_ROOT, ".scratch", "hero")
export const HERO_HOME: string = join(HERO_ROOT, "home")
/** Settings blob path derives from the Rove home, not from `XDG_CONFIG_HOME`. */
export const HERO_CONFIG: string = join(HERO_HOME, ".config")
/** Repo directory name is visible in the sidebar — keep it product-plausible. */
export const HERO_REPO: string = join(HERO_ROOT, "orbit-sdk")

/** Inherited names that would drag the capture onto the operator's daemon. */
const SCRUBBED = [
  "DAEMON_SOCKET_PATH",
  "DAEMON_PID_PATH",
  "PTY_SOCKET_PATH",
  "PTY_PID_PATH",
  "TASK_ID",
  "TAB_ID",
  "TERMINAL_PTY",
  "HOME_DIR",
  "SANDBOX_HOME_DIR",
  "DAEMON_WEB_PORT",
  "SANDBOX_DAEMON_WEB_PORT",
  "WEB_PORT",
  "PTY_PORT",
] as const

/**
 * Claude Code marks its own child processes (`CLAUDECODE`,
 * `CLAUDE_CODE_CHILD_SESSION`, …). A capture driven from inside a Rove task —
 * i.e. from inside Claude Code — leaks those markers down to the engine under
 * capture, which then boots with "Transcript saving is off" and writes no
 * session file at all. The engine-owned history the chat pane renders comes
 * from that file, so the photographed workspace degrades to a raw terminal.
 */
export const CLAUDE_MARKERS: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
]

function scrubbed(parent: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (CLAUDE_MARKERS.includes(key)) continue
    const suffix = key.startsWith("KOBE_") ? key.slice(5) : key.startsWith("ROVE_") ? key.slice(5) : null
    if (suffix !== null && (SCRUBBED as readonly string[]).includes(suffix)) continue
    out[key] = value
  }
  return out
}

/** Both namespaces, so no compatibility alias can outrank the isolation. */
function stamp(env: Record<string, string>, suffix: string, value: string): void {
  env[`KOBE_${suffix}`] = value
  env[`ROVE_${suffix}`] = value
}

export function heroEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = scrubbed(parent)
  env.TERM = "xterm-256color"
  env.COLORTERM = "truecolor"
  stamp(env, "HOME_DIR", HERO_HOME)
  stamp(env, "SANDBOX_HOME_DIR", HERO_HOME)
  stamp(env, "DAEMON_WEB_PORT", String(HERO_DAEMON_PORT))
  stamp(env, "SANDBOX_DAEMON_WEB_PORT", String(HERO_DAEMON_PORT))
  return env
}

/**
 * `sh -lc` string the PTY sidecar runs as the harness TUI. A login shell
 * re-reads the operator's rc files, so every isolation variable is re-stated
 * inline rather than trusted to survive the hop.
 */
export function heroPtyCommand(): string {
  const inline = [
    `ROVE_HOME_DIR=${HERO_HOME}`,
    `KOBE_HOME_DIR=${HERO_HOME}`,
    `ROVE_SANDBOX_HOME_DIR=${HERO_HOME}`,
    `KOBE_SANDBOX_HOME_DIR=${HERO_HOME}`,
    `ROVE_DAEMON_WEB_PORT=${HERO_DAEMON_PORT}`,
    `KOBE_DAEMON_WEB_PORT=${HERO_DAEMON_PORT}`,
    `ROVE_SANDBOX_DAEMON_WEB_PORT=${HERO_DAEMON_PORT}`,
    `KOBE_SANDBOX_DAEMON_WEB_PORT=${HERO_DAEMON_PORT}`,
    "ROVE_DAEMON_SOCKET_PATH=",
    "KOBE_DAEMON_SOCKET_PATH=",
    "ROVE_PTY_SOCKET_PATH=",
    "KOBE_PTY_SOCKET_PATH=",
    "ROVE_TASK_ID=",
    "KOBE_TASK_ID=",
    "ROVE_TAB_ID=",
    "KOBE_TAB_ID=",
  ].join(" ")
  return `unset ${CLAUDE_MARKERS.join(" ")}; ${inline} bun run dev:sandbox`
}
