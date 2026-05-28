/**
 * tmux-backed interactive sessions (v0.6).
 *
 * Per-task tmux session running inside a dedicated socket (`tmux -L
 * kobe`). Each session is pre-split into three panes — claude on the
 * left, the `kobe ops` FileTree pane on the upper right, and an
 * interactive shell on the lower right. The whole composition is
 * rendered by tmux, so claude can repaint at native speed without
 * kobe's outer renderer fighting it for the TTY.
 *
 * Layout grammar (v0.6 / KOB-228):
 *
 *     ┌──────────────────────┬───────────────┐
 *     │                      │  pane 1: ops  │
 *     │   pane 0: claude     │               │
 *     │   (left, ~60%)       ├───────────────┤
 *     │                      │  pane 2: sh   │
 *     └──────────────────────┴───────────────┘
 *
 * `Ctrl+Q` detaches the client (server-scoped binding on `-L kobe`,
 * so the user's own tmux is untouched). The session keeps running
 * after detach AND across a kobe restart.
 *
 * NOTE on the "kobe deliberately does NOT use tmux" rule in `pty.ts`:
 * that still holds for the legacy terminal-pane shell backend. tmux
 * is used here only for the interactive engine session, where
 * persistence + native attach are exactly what tmux is good at.
 */

import { fileURLToPath } from "node:url"
import {
  attachArgv,
  killSession,
  listPaneIds,
  runTmux,
  runTmuxCapturing,
  sessionExists,
  tmuxAvailable,
  tmuxSessionName,
} from "@/tmux/client"

// Re-export the shared identity/lifecycle helpers so existing importers
// (`app.tsx`, `LivePreview`, `fullscreen.tsx`) keep their `./tmux` path.
export { attachArgv, killSession, sessionExists, tmuxAvailable, tmuxSessionName }

/**
 * The argv prefix that re-invokes the kobe CLI for a subcommand from
 * inside a tmux pane. In a packaged install this is just `kobe`
 * (on PATH via npm's bin shim). In dev (`bun run dev`) there's no
 * `kobe` on PATH, so we reconstruct `<bun> <cli-entry>` from the
 * current process — `process.execPath` is bun, and the CLI entry is
 * resolved relative to this module (mirrors the old MCP-bridge entry
 * resolution). Extension follows our own (`.ts` in dev, `.js` built).
 */
function kobeCliInvocation(): string[] {
  // Packaged: the `kobe` bin shim is on PATH. Detect "are we running
  // from a dist build" by checking the module extension.
  const isBuilt = import.meta.url.endsWith(".js")
  if (isBuilt) return ["kobe"]
  // Dev (`bun run dev`): there's no `kobe` on PATH, and the child must
  // boot opentui/solid the same way the dev script does — with the
  // JSX preload + the `browser` export condition. Without these the
  // child crashes with "Export named 'jsxDEV' not found".
  //
  // The preload must be an ABSOLUTE path: the Ops pane runs with the
  // worktree as its cwd, and `--preload @opentui/solid/preload`
  // resolves relative to cwd — the worktree's node_modules won't have
  // opentui, so a bare specifier fails. `import.meta.resolve` resolves
  // against THIS module (inside the kobe package), so it always finds
  // kobe's own copy regardless of the child's cwd.
  const entry = fileURLToPath(new URL("../../../cli/index.ts", import.meta.url))
  const preload = fileURLToPath(import.meta.resolve("@opentui/solid/preload"))
  return [process.execPath, "--preload", preload, "--conditions=browser", entry]
}

/** Default left-pane width as a percentage of the window. */
const CLAUDE_PANE_PERCENT = 60

/** Default upper-right (Ops) pane height as a percentage of the right column. */
const OPS_PANE_PERCENT = 50

/**
 * Count the panes across every window of the session. Used to detect
 * old (v0.5 / KOB-225) one-pane sessions so {@link ensureSession} can
 * rebuild them with the three-pane layout. `listPaneIds` walks the
 * whole session (`-s`), so it sidesteps the user's `base-index` config.
 */
async function paneCount(name: string): Promise<number> {
  return (await listPaneIds(name)).length
}

export interface EnsureSessionOpts {
  readonly name: string
  /** Working directory for every pane in the new session. */
  readonly cwd: string
  /** argv that pane 0 (the claude pane) runs. */
  readonly command: readonly string[]
  /**
   * Shell command line that pane 1 (the Ops pane) runs. Defaults to
   * `kobe ops --task-id <taskId> --worktree <cwd> --target-pane <id>`
   * (the FileTree pane — see `tui/ops/host.tsx`); if that launch fails
   * we fall back to the inline git-status + tree watcher.
   */
  readonly opsCommand?: string
  /**
   * Stable kobe task id — used to build the default `kobe ops` argv
   * and the `target-pane` selector. Optional so callers that supply
   * their own `opsCommand` don't need to pass it.
   */
  readonly taskId?: string
}

/**
 * Resolve the default Ops pane shell command. Prefers `kobe ops`
 * (the v0.5 FileTree pane re-hosted as a subcommand — see
 * `tui/ops/host.tsx`), falling back to an inline shell loop that
 * prints `git status` + a tree if that launch fails for any reason.
 *
 * Returns a single shell command STRING (not an argv) — tmux runs the
 * pane command via `sh -c`, so building the string ourselves and
 * letting tmux's own sh execute it avoids the send-keys re-parse +
 * double-quoting trap (KOB-233: an argv joined with spaces lost the
 * `sh -c "<script>"` quoting and the pane ran the wrong thing).
 *
 * `claudePaneId` is the tmux pane id (`%N`) of the claude pane — pane
 * ids are server-global and survive `base-index` differences, so the
 * Ops pane sends keystrokes (`@file` mentions) back to claude by id
 * rather than by index.
 */
function defaultOpsCommand(cwd: string, taskId: string | undefined, claudePaneId: string | null): string {
  if (taskId && claudePaneId) {
    const inv = kobeCliInvocation().map(shellQuote).join(" ")
    return (
      `${inv} ops --task-id ${shellQuote(taskId)} --worktree ${shellQuote(cwd)} --target-pane ${shellQuote(claudePaneId)} ` +
      `|| { ${fallbackOpsScript(cwd)}; }`
    )
  }
  return fallbackOpsScript(cwd)
}

/**
 * Plain shell-command string that prints `git status` + a tree on a
 * loop. Used either directly (when no taskId is provided) or as the
 * `||` fallback after `kobe-ops` fails to launch.
 */
function fallbackOpsScript(cwd: string): string {
  return `\
cd ${shellQuote(cwd)} && \
while :; do \
  clear; \
  printf "\\033[1m# %s\\033[0m\\n\\n" ${shellQuote(cwd)}; \
  git status --short --branch 2>/dev/null | sed 's/^/  /' || true; \
  printf "\\n"; \
  if command -v lsd >/dev/null 2>&1; then \
    lsd --tree --git -I node_modules -I .git --depth 2 .; \
  elif command -v eza >/dev/null 2>&1; then \
    eza --tree --git -L 2 -I 'node_modules|.git' .; \
  elif command -v tree >/dev/null 2>&1; then \
    tree -L 2 -I 'node_modules|.git'; \
  else \
    ls -la; \
  fi; \
  sleep 2; \
done`
}

/**
 * Quote `s` for safe inclusion inside a single-line `sh -c` script.
 * tmux's `split-window` argv passes one string per panel — we build
 * that string ourselves, so any path with a space or quote needs
 * shell-quoting before it reaches the child shell.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Turn an argv array into a shell-safe command line for `send-keys`.
 *
 * `send-keys` sends literal text that the pane's shell re-parses, so a
 * pre-tokenized argv must be re-quoted — `argv.join(" ")` silently
 * breaks any element containing spaces or quotes. KOB-233 bug: the Ops
 * command `["sh", "-c", "<multi-word script>"]` joined to
 * `sh -c <unquoted script>`, which the pane shell parsed as
 * `sh -c <first-word>` with the rest as positional args, so `kobe ops`
 * never ran and the `|| fallback` loop took over instead.
 */
function shellQuoteArgv(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ")
}

/**
 * Ensure a detached session named `name` exists with the three-pane
 * layout. Idempotent in the happy path: a session that already has
 * the right number of panes is left alone (that's the persistence —
 * a prior session keeps running across detach / kobe restart). A
 * legacy one-pane session is detected by {@link paneCount} and
 * **rebuilt**: killed and recreated. We choose rebuild over in-place
 * `split-window` because a pre-v0.6 session's pane 0 is already
 * running claude with whatever scrollback state the user has, and
 * splitting now would create empty panes 1/2 alongside it — fine for
 * fresh tasks, but the layout would only become "correct" after the
 * user's next kobe restart anyway. Rebuilding gives every existing
 * task the new look on first re-enter.
 */
export async function ensureSession(opts: EnsureSessionOpts): Promise<void> {
  if (await sessionExists(opts.name)) {
    const panes = await paneCount(opts.name)
    if (panes >= 3) return
    // Legacy / broken layout — drop and rebuild from scratch.
    await runTmux(["kill-session", "-t", `=${opts.name}`])
  }

  // Build the session in three splits, capturing each pane's tmux
  // pane id (`%N`) so we can target by id afterwards. Pane ids are
  // server-global and immune to the user's `base-index` /
  // `pane-base-index` config — targeting by `=name:0.0` (which we did
  // first) broke on any tmux server using `base-index 1`, the default
  // in most popular tmux configs. Bug history: KOB-233.
  //
  // Layout grammar:
  //   step 1: new-session -d                 → pane 0 (left, full size)
  //   step 2: split-window -h (40% right)    → pane 1 (right column)
  //   step 3: split-window -v on pane 1 (50%) → pane 2 (right bottom)
  // -l N% is the modern replacement for the deprecated -p N flag.
  // Each pane's command is passed as the trailing arg to
  // new-session / split-window — tmux runs it via its own `sh -c`,
  // so we hand it a single shell command STRING and skip send-keys
  // entirely. send-keys re-parses text through the pane's shell,
  // which mangled the Ops pane's `sh -c "<script>"` quoting (KOB-233).
  //
  // `; exec "${SHELL:-/bin/sh}"` keeps the pane alive after its
  // command exits: instead of tmux closing the pane (and collapsing
  // the layout), the user lands in an interactive shell. claude
  // exiting → shell; kobe ops exiting → shell; the Ops fallback loops
  // forever so it never reaches the exec.
  const keepAlive = (cmd: string): string => `${cmd}; exec "\${SHELL:-/bin/sh}"`
  const claudeCmd = keepAlive(shellQuoteArgv(opts.command))

  const r0 = await runTmuxCapturing([
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    opts.cwd,
    "-P",
    "-F",
    "#{pane_id}",
    claudeCmd,
  ])
  const pane0 = r0.stdout.trim()
  if (!pane0) {
    console.error("[kobe tmux] new-session returned no pane id; session creation failed")
    return
  }

  // Resolve the Ops command now that we know pane 0's id — kobe ops
  // uses it as the `--target-pane` selector for `@file` send-keys
  // injections back into claude.
  const opsCmd = keepAlive(opts.opsCommand ?? defaultOpsCommand(opts.cwd, opts.taskId, pane0))

  const r1 = await runTmuxCapturing([
    "split-window",
    "-h",
    "-t",
    pane0,
    "-l",
    `${100 - CLAUDE_PANE_PERCENT}%`,
    "-c",
    opts.cwd,
    "-P",
    "-F",
    "#{pane_id}",
    opsCmd,
  ])
  const pane1 = r1.stdout.trim()

  // Pane 2 (bottom right) is a plain shell scoped to the worktree —
  // no command, tmux uses its default-command ($SHELL).
  if (pane1) {
    await runTmuxCapturing([
      "split-window",
      "-v",
      "-t",
      pane1,
      "-l",
      `${100 - OPS_PANE_PERCENT}%`,
      "-c",
      opts.cwd,
      "-P",
      "-F",
      "#{pane_id}",
    ])
  }

  // Server-scoped niceties — done after the session is alive so the
  // server is definitely up. All `-g` options are idempotent so
  // calling them on every ensureSession is harmless.
  //
  // Status bar: ON (KOB-233). v0.5/KOB-225 hid it because there was
  // only one pane and it was pure noise. With three panes it's useful
  // — it tells the user they're inside a kobe-managed tmux session,
  // which pane/window is active, and how to get out. We explicitly
  // set `on` (not just "leave default") so a server that an older
  // kobe turned OFF flips back.
  //
  // We deliberately do NOT set status-style / status-left /
  // status-right: the `-L kobe` socket still loads the user's
  // `~/.tmux.conf` (the `-L` flag only changes the socket path, not
  // the config file), so the user's own status-bar theme applies.
  // The session name (`kobe-<task-id>`, shown via the user's
  // default `#S` in status-left) is the only identity we impose.
  await runTmux(["set-option", "-g", "status", "on"])
  // No-prefix Ctrl+Q detaches back to the kobe outer monitor.
  await runTmux(["bind-key", "-n", "C-q", "detach-client"])

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — so a user who detached from Ops
  // lands back in Ops.
  await runTmux(["select-pane", "-t", pane0])
}
