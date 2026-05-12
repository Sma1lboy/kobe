/**
 * Modal terminal — full-window takeover for native typing latency.
 *
 * Rationale: kobe's embedded terminal pane goes through Solid + opentui's
 * render loop on every keystroke. That's ~10-20 ms of paint cost per
 * character, and it's perceptible compared to a real terminal. We can't
 * remove that cost while opentui is rendering the pane.
 *
 * Trick: tmux already keeps the live shell as a server-side session
 * (`kobe-task-<id>`). For "native typing right now" we suspend opentui
 * entirely, spawn a real `tmux attach -t <name>` child with
 * `stdio: "inherit"`, and the user types directly into tmux for the
 * duration of the modal. Zero opentui, zero JS in the keystroke path —
 * it IS a real tmux client.
 *
 * Exit: a real tmux session ignores plain Escape (vim, less, htop all
 * rely on it). Instead we set tmux's prefix to Escape on this session
 * and bind `prefix + Escape` to `detach-client`. Result:
 *
 *   - Single Esc: tmux's escape-time window opens (300 ms default).
 *     If nothing follows, the Esc is forwarded to the running app —
 *     vim leaves insert mode, less quits, etc.
 *   - Esc Esc within 300 ms: tmux detaches the client. The spawned
 *     child exits, kobe's renderer resumes, the 5-pane view is back.
 *
 * The 300 ms delay before single-Esc reaches vim is unavoidable with
 * a sequential-key scheme — it's the price of "double tap = detach".
 *
 * Why scope tmux's prefix change to one session (not the server): the
 * user may have other tmux sessions on the same server. Per-session
 * options keep our binding from affecting them. `bind-key -T prefix`
 * IS server-global, but it only fires after the session's prefix is
 * pressed, so other sessions (with the default `Ctrl+B` prefix) are
 * untouched.
 */

import { spawn, spawnSync } from "node:child_process"

export type EnterModalOpts = {
  /** Tmux binary to invoke. Should match what created the session. */
  tmuxBin: string
  /** Target session name — e.g. `kobe-task-<ulid>`. */
  sessionName: string
  /**
   * Called synchronously BEFORE the child is spawned. The caller must
   * `renderer.suspend()` opentui here so the screen is free for tmux
   * to draw into.
   */
  onSuspend: () => void
  /**
   * Called when the modal child exits (clean detach OR error). The
   * caller must `renderer.resume()` opentui here and trigger a redraw.
   */
  onResume: () => void
}

/**
 * Per-session "prefix bound for modal exit" cache. Configuring the
 * prefix-table binding is cheap, but skipping the spawnSync triples
 * makes repeated entries snappier.
 */
const configured = new Set<string>()

/**
 * Configure session-scoped Esc-as-prefix and the Esc-Esc detach
 * binding. Idempotent per session.
 */
function configureSessionForModal(tmuxBin: string, sessionName: string): void {
  if (configured.has(sessionName)) return
  // Best-effort: each spawnSync is its own try/catch so a single
  // failed option doesn't skip the others.
  try {
    spawnSync(tmuxBin, ["set-option", "-t", sessionName, "prefix", "Escape"])
  } catch {
    /* best effort */
  }
  try {
    spawnSync(tmuxBin, ["set-option", "-t", sessionName, "escape-time", "300"])
  } catch {
    /* best effort */
  }
  // The prefix table is server-global, but only fires when a session
  // with prefix=Escape is the active client. Setting this once is
  // enough; we still do it per-entry idempotently in case another
  // tmux client rebound the key out from under us.
  try {
    spawnSync(tmuxBin, ["bind-key", "-T", "prefix", "Escape", "detach-client"])
  } catch {
    /* best effort */
  }
  configured.add(sessionName)
}

/**
 * Enter modal terminal mode. Spawns a real `tmux attach` taking over
 * kobe's tty until the user double-taps Esc (or the child exits for
 * any other reason). Non-blocking — `onResume` fires when the modal
 * ends.
 */
export function enterModalTerminal(opts: EnterModalOpts): void {
  const { tmuxBin, sessionName, onSuspend, onResume } = opts

  configureSessionForModal(tmuxBin, sessionName)

  // The order matters: suspend opentui FIRST so it stops writing to
  // stdout, then hand stdio to tmux. Reversing this lets opentui's
  // last frame race against tmux's initial paint.
  onSuspend()

  let resumed = false
  const doResume = (): void => {
    if (resumed) return
    resumed = true
    onResume()
  }

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(tmuxBin, ["attach", "-t", sessionName], {
      // `inherit` connects the child's stdio directly to our tty —
      // tmux client reads real keystrokes, writes real ANSI bytes,
      // no proxy. This is the difference between "native typing
      // latency" and "still going through JS."
      stdio: "inherit",
    })
  } catch (err) {
    // Failed to even fork tmux — resume immediately so the user isn't
    // stuck on a black screen.
    void err
    doResume()
    return
  }

  child.on("exit", doResume)
  child.on("error", doResume)
}
