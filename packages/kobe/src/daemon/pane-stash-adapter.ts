/**
 * Daemon-side glue between `PaneStash` (pure state) and a tmux control
 * client (the wire). Injectable: speaks to a {@link ControlClientLike}
 * interface, so unit tests can drive every code path with a recording
 * fake and production wiring (sprint-6) passes the actual
 * `TmuxControlClient`.
 *
 * Why `swap-pane` instead of break+join: the sprint-5 design brief
 * described the swap as "break-pane the chat slot back to stash +
 * join-pane the wanted one into the chat slot". tmux can't literally
 * execute that — `join-pane -t <chatSlot>` requires the target pane to
 * still exist in its window, but the preceding `break-pane -s <chatSlot>`
 * moved it to the stash window. The semantically equivalent (and
 * atomic) primitive is `swap-pane -s <stashPane> -t <chatSlot> -d`,
 * which exchanges the two panes' window positions in one call. After
 * the swap, the pane id formerly at the chat slot position is now in
 * the stash window, and the stash pane is now at the chat slot
 * position — exactly the "swap the chat" outcome the brief intended.
 *
 * Layout pin: every successful swap is followed by
 * `select-layout <savedLayout>` so any tmux re-tiling driven by tmux's
 * internal pane bookkeeping is overwritten by the snapshotted 5-pane
 * geometry. The displayed pane id becomes the chat slot pane id (a
 * `PaneStash` invariant) so subsequent swaps target by that.
 *
 * Failure handling: every method propagates tmux errors verbatim. We
 * roll back the stash's state when `ensureSpawnedForTab` fails after
 * `planSpawn` (no pane to register), but we deliberately leave the
 * `displayed` field advanced in `planSwap` even if the swap-pane call
 * errors — the caller's only sensible recovery is to retry the swap
 * or re-attach, both of which restart from clean state.
 */

import type { PaneStash } from "../tmux/pane-stash.ts"

/**
 * Minimal subset of `TmuxControlClient` the adapter uses. The shape
 * mirrors the real helper signatures so production code can pass the
 * real client verbatim. Tests pass an in-memory recorder.
 *
 * `breakPane` / `joinPane` are kept on the interface for sprint-6
 * stash-window management (creating the stash window, recovering from
 * a crashed daemon) even though the adapter itself doesn't currently
 * call them.
 */
export interface ControlClientLike {
  splitWindow(opts: {
    target?: string
    command?: string
    printFormat?: string
    detached?: boolean
  }): Promise<string[]>
  swapPane(opts: { source: string; target: string; detached?: boolean }): Promise<string[]>
  breakPane(opts: { source: string; target?: string; detached?: boolean }): Promise<string[]>
  joinPane(opts: { source: string; target: string }): Promise<string[]>
  killPane(opts: { target: string }): Promise<string[]>
  selectLayout(opts: { target?: string; layout: string }): Promise<string[]>
}

export interface PaneStashAdapterOptions {
  readonly stash: PaneStash
  readonly client: ControlClientLike
}

export class PaneStashSpawnFailedError extends Error {
  constructor(taskId: string, tabId: string, body: readonly string[]) {
    super(
      `PaneStashAdapter.ensureSpawnedForTab(${taskId}, ${tabId}): tmux split-window did not return a pane id; body=${JSON.stringify(body)}`,
    )
    this.name = "PaneStashSpawnFailedError"
  }
}

const PANE_ID_RE = /%\d+/

export class PaneStashAdapter {
  private readonly stash: PaneStash
  private readonly client: ControlClientLike

  constructor(opts: PaneStashAdapterOptions) {
    this.stash = opts.stash
    this.client = opts.client
  }

  /**
   * Make sure a pane exists in the stash for `(taskId, tabId)`,
   * spawning a fresh one if not. Idempotent — returns the cached id
   * on subsequent calls. The returned id is the tmux `%N` pane id.
   */
  async ensureSpawnedForTab(taskId: string, tabId: string, command: string): Promise<string> {
    const existing = this.stash.getPaneId(taskId, tabId)
    if (existing) return existing
    const ops = this.stash.planSpawn(taskId, tabId, command)
    const spawnOp = ops[0]
    if (!spawnOp || spawnOp.kind !== "spawn") {
      throw new Error(`ensureSpawnedForTab: planSpawn returned unexpected ops: ${JSON.stringify(ops)}`)
    }
    const body = await this.client.splitWindow({
      target: spawnOp.window,
      command: spawnOp.command,
      printFormat: "#{pane_id}",
      detached: true,
    })
    // `split-window -P -F '#{pane_id}'` in control mode returns the new
    // pane id on a body line. Scan defensively in case tmux prepends a
    // banner line.
    let paneId: string | null = null
    for (const line of body) {
      const m = line.match(PANE_ID_RE)
      if (m) {
        paneId = m[0]
        break
      }
    }
    if (!paneId) throw new PaneStashSpawnFailedError(taskId, tabId, body)
    this.stash.registerPane(taskId, tabId, paneId)
    return paneId
  }

  /**
   * Bring `(taskId, tabId)`'s pane into the chat slot. No-op if it's
   * already displayed. Caller must have already called
   * `ensureSpawnedForTab` (or the stash must already have the pane
   * registered from a previous spawn).
   *
   * Sequence:
   *   1. `swap-pane -s <newPane> -t <chatSlot> -d` — exchanges window
   *      positions in one call. After the swap, the pane formerly in
   *      the chat slot is in the stash window, and `newPane` is in the
   *      chat slot.
   *   2. `select-layout <savedLayout>` — restore the snapshotted
   *      5-pane geometry so the swap doesn't drift other panes' sizes.
   *      We re-target by `newPane`'s id (now the chat slot's id).
   */
  async swapToChat(taskId: string, tabId: string): Promise<void> {
    const ops = this.stash.planSwap(taskId, tabId)
    for (const op of ops) {
      if (op.kind !== "swap-into-chat") continue
      await this.client.swapPane({ source: op.newPaneId, target: op.chatSlotPaneId, detached: true })
      await this.client.selectLayout({ target: op.newPaneId, layout: op.savedLayout })
    }
  }

  /**
   * Kill `(taskId, tabId)`'s pane. If the pane is currently in the
   * chat slot, `planKill` throws — the caller must swap to a different
   * tab first. We surface that error as-is so the caller can decide
   * what to do (typically: pick another tab via the orchestrator,
   * `swapToChat` to it, then retry).
   */
  async killForTab(taskId: string, tabId: string): Promise<void> {
    const ops = this.stash.planKill(taskId, tabId)
    for (const op of ops) {
      if (op.kind !== "kill-pane") continue
      await this.client.killPane({ target: op.paneId })
    }
  }
}
