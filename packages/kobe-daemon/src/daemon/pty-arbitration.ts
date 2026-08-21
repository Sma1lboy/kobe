/**
 * Multi-client arbitration for one hosted PTY session — the contract for
 * what happens when a session key carries MORE THAN ONE attached
 * connection (a TUI pane, a browser tab, an api reader, in any mix).
 *
 * Every attached connection holds a sink in `PtySessionState.sinks`, and
 * the rules below are the whole of "two clients, one child". Kept out of
 * `pty-host.ts` on purpose: the host owns lifetime, ring buffer, and
 * freeze; this module is pure over the session state and is where the
 * arbitration semantics are documented and tested.
 *
 * ## Input — tmux semantics: every attached client may write
 *
 * No exclusive-writer lock, no read-only attach mode. Any attached client
 * may `pty.write`; ordering between clients is arrival order at the host
 * socket, and that is the entire rule. Two clients typing at once is
 * exactly as messy as two people sharing a tmux session, which is the
 * behavior people already expect from a shared terminal.
 *
 * Contiguity is guaranteed *within* one payload, not across payloads:
 * each `pty.write` reaches the child through exactly one synchronous
 * {@link PtyChild.write}, so client B can never land bytes in the middle
 * of client A's chunk. Whether A's two chunks stay adjacent is not
 * promised — nothing on a shared terminal could promise that.
 *
 * Echo falls out of the fan-out rather than being a separate mechanism:
 * the child's output goes to every sink, so a keystroke from B reaches A
 * as ordinary child output. No client ever echoes locally.
 *
 * ## Resize — last writer wins
 *
 * The most recent `pty.resize` sets the child's grid, whoever sent it.
 * Deliberately NOT min-of-all-clients letterboxing: the session is sized
 * for whoever touched it last, and a client with a smaller viewport sees
 * wrapped or truncated output until it resizes back. Same ceiling tmux
 * grouped sessions have, and it keeps the common case (one real client
 * plus a peeker) exact instead of shrinking it for an observer.
 *
 * Two guards keep that from thrashing:
 *
 *  - {@link applyResize} is a NO-OP when the grid is unchanged, so a
 *    client re-reporting its own size (an xterm fit-addon fires on every
 *    layout pass) costs nothing and raises no SIGWINCH the child would
 *    repaint for. No time-based debounce is used: a debounce only slows a
 *    genuine loop, while an idempotence check ends it — and any window
 *    long enough to matter would also swallow a real drag-resize.
 *  - a real change is broadcast to the OTHER attached clients as a
 *    `pty.resized` event so their local VT emulator can follow the child's
 *    actual grid instead of silently misrendering wrapped output.
 *    Consumers MUST treat that frame as informational and must NOT answer
 *    it with a `pty.resize` request of their own. Echoing it back is the
 *    one way to build a ping-pong the idempotence check cannot see, since
 *    each side would then report genuinely different dimensions.
 */

import type { DaemonFrame } from "./protocol.ts"
import type { PtySessionState } from "./pty-host-types.ts"

/**
 * Fan one event frame out to every attached sink. `except` skips the
 * connection that caused it — used for the resize broadcast, where the
 * sender already knows. Output frames pass no `except`: the client whose
 * keystroke produced them still wants the child's echo.
 *
 * This is the ONE place that walks `session.sinks`, so it is also the one
 * place that has to change if per-client state ever hangs off that map
 * (presence). Enrich the map's value type in `pty-host-types.ts` and adjust
 * the destructuring here — do not grow a second parallel registry.
 */
export function fanOut(session: PtySessionState, frame: DaemonFrame, except?: object): void {
  for (const [token, sink] of session.sinks) {
    if (token === except) continue
    sink(frame)
  }
}

/** Forward one client's input to the child — see "Input" above. */
export function writeInput(session: PtySessionState, data: string): void {
  if (!session.alive || data.length === 0) return
  try {
    session.proc?.write(data)
  } catch {
    // A terminal stream error is not proof the subprocess exited. The
    // host's `proc.exited` watcher is the single source of truth.
  }
}

/**
 * Last-writer-wins resize. Returns true when the child's grid actually
 * moved; false for a dead session or an unchanged (idempotent) request,
 * which is the caller's cue to skip both the SIGWINCH and the broadcast.
 */
export function applyResize(session: PtySessionState, cols: number, rows: number): boolean {
  if (!session.alive) return false
  if (session.cols === cols && session.rows === rows) return false
  session.cols = cols
  session.rows = rows
  try {
    session.proc?.resize(cols, rows)
  } catch {
    // See writeInput(): wait for `proc.exited`, not the PTY stream state.
  }
  return true
}

/**
 * Targeted `pty.resized` event payload — the session's child grid changed
 * because SOME attached client resized it. Sent to every attached
 * connection EXCEPT the one that asked, so a client whose viewport differs
 * can follow the child's real dimensions instead of misrendering wrapped
 * output. Informational ONLY: a receiver must not answer it with a
 * `pty.resize` request of its own (see the module header).
 *
 * Declared here rather than in `protocol.ts` because that file is at the
 * repo's ~500-line cap; the wire name lives in `DaemonEventName`.
 */
export interface PtyResizeEventPayload {
  readonly key: string
  readonly cols: number
  readonly rows: number
}

/** The informational `pty.resized` event the other attached clients follow. */
export function resizeFrame(key: string, cols: number, rows: number): DaemonFrame {
  const payload: PtyResizeEventPayload = { key, cols, rows }
  return { type: "event", name: "pty.resized", payload }
}
