/**
 * End-to-end smoke test for `PaneStashAdapter` driving a real tmux.
 * Builds the actual 5-pane main window via `buildLayoutSteps` and then
 * exercises swap-into-chat against a second hidden "stash" window.
 *
 * Gated on tmux availability: behavior runner sets KOBE_INCLUDE_BEHAVIOR=1
 * but the host may not have tmux installed (CI minimal containers).
 *
 * `afterEach` kills the session via the plain CLI so an assertion
 * failure never leaks an orphaned tmux server.
 */

import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, expect, it } from "vitest"
import { PaneStashAdapter } from "../../src/daemon/pane-stash-adapter.ts"
import { type TmuxControlClient, spawnControlClient } from "../../src/tmux/control-client.ts"
import {
  DEFAULT_PLACEHOLDERS,
  type LayoutStep,
  type PaneLabel,
  buildLayoutSteps,
  placeholderShellCommand,
} from "../../src/tmux/layout.ts"
import { createPaneStash } from "../../src/tmux/pane-stash.ts"

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0

let session = ""
let client: TmuxControlClient | null = null

beforeEach(() => {
  const id = Math.random().toString(36).slice(2, 8)
  session = `kobe-swap-${id}`
})

afterEach(async () => {
  if (client) {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
    client = null
  }
  if (session) {
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
  }
})

function tmuxCli(...args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("tmux", args, { encoding: "utf8" })
  return { status: r.status ?? -1, stdout: (r.stdout ?? "").toString(), stderr: (r.stderr ?? "").toString() }
}

function tmuxCapture(args: string[]): string {
  const r = tmuxCli(...args)
  if (r.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (${r.status}): ${r.stderr.trim()}`)
  }
  return r.stdout.trim()
}

function runLayoutStepViaCli(step: LayoutStep, paneIds: Map<PaneLabel, string>): void {
  if (step.kind === "new-session") {
    const id = tmuxCapture([
      "new-session",
      "-d",
      "-s",
      step.sessionName,
      "-n",
      step.windowName,
      "-P",
      "-F",
      "#{pane_id}",
      step.command,
    ])
    paneIds.set(step.name, id)
    return
  }
  if (step.kind === "split") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`unknown target ${step.targetLabel}`)
    const id = tmuxCapture([
      "split-window",
      `-${step.direction}`,
      "-t",
      target,
      "-l",
      step.size,
      "-P",
      "-F",
      "#{pane_id}",
      step.command,
    ])
    paneIds.set(step.name, id)
    return
  }
  if (step.kind === "resize") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`unknown target ${step.targetLabel}`)
    tmuxCapture(["resize-pane", "-t", target, "-y", String(step.heightRows)])
    return
  }
  if (step.kind === "select") {
    const target = paneIds.get(step.targetLabel)
    if (!target) throw new Error(`unknown target ${step.targetLabel}`)
    tmuxCapture(["select-pane", "-t", target])
    return
  }
}

it.skipIf(!tmuxAvailable)(
  "PaneStashAdapter swaps stash panes into the chat slot, preserves layout, and supports kill",
  async () => {
    // 1. Build the actual 5-pane main window via the layout module, then
    //    capture the chat slot's pane id + the snapshotted layout string.
    const steps = buildLayoutSteps({ sessionName: session, placeholders: DEFAULT_PLACEHOLDERS })
    const paneIds = new Map<PaneLabel, string>()
    for (const step of steps) runLayoutStepViaCli(step, paneIds)

    const chatSlotId = paneIds.get("chat")
    expect(chatSlotId).toMatch(/^%\d+$/)
    if (!chatSlotId) throw new Error("expected chat pane id")
    const savedLayout = tmuxCapture(["display-message", "-p", "-t", `${session}:kobe`, "#{window_visible_layout}"])
    expect(savedLayout.length).toBeGreaterThan(0)

    // 2. Create the hidden stash window (one placeholder pane to begin
    //    with — the adapter will split-window into it to add per-tab
    //    panes).
    tmuxCapture(["new-window", "-d", "-t", session, "-n", "stash", placeholderShellCommand("stash-init")])
    const stashTarget = `${session}:stash`

    // 3. Bring up the control client + adapter against the live session.
    client = await spawnControlClient({ session })
    const stash = createPaneStash()
    stash.attach({ stashWindow: stashTarget, chatSlotPaneId: chatSlotId, savedLayout })
    const adapter = new PaneStashAdapter({ stash, client })

    // 4. Spawn two panes in stash (one per "tab").
    const paneA = await adapter.ensureSpawnedForTab("taskA", "tab1", placeholderShellCommand("paneA"))
    const paneB = await adapter.ensureSpawnedForTab("taskA", "tab2", placeholderShellCommand("paneB"))
    expect(paneA).toMatch(/^%\d+$/)
    expect(paneB).toMatch(/^%\d+$/)
    expect(paneA).not.toBe(paneB)

    // Stash window contains both (plus the seed pane); main window does not.
    let stashPanesAfterSpawn = await client.listPanes({ target: stashTarget, format: "#{pane_id}" })
    let mainPanesAfterSpawn = await client.listPanes({ target: `${session}:kobe`, format: "#{pane_id}" })
    expect(stashPanesAfterSpawn).toEqual(expect.arrayContaining([paneA, paneB]))
    expect(mainPanesAfterSpawn).not.toContain(paneA)
    expect(mainPanesAfterSpawn).not.toContain(paneB)

    // 5. Swap paneA into the chat slot.
    await adapter.swapToChat("taskA", "tab1")
    let mainPanes = await client.listPanes({ target: `${session}:kobe`, format: "#{pane_id}" })
    let stashPanes = await client.listPanes({ target: stashTarget, format: "#{pane_id}" })
    expect(mainPanes).toContain(paneA)
    expect(mainPanes).not.toContain(paneB)
    expect(stashPanes).not.toContain(paneA)
    expect(stashPanes).toContain(paneB)

    // 6. Swap paneB into the chat slot (replaces paneA).
    await adapter.swapToChat("taskA", "tab2")
    mainPanes = await client.listPanes({ target: `${session}:kobe`, format: "#{pane_id}" })
    stashPanes = await client.listPanes({ target: stashTarget, format: "#{pane_id}" })
    expect(mainPanes).toContain(paneB)
    expect(mainPanes).not.toContain(paneA)
    expect(stashPanes).toContain(paneA)
    expect(stashPanes).not.toContain(paneB)

    // 7. Layout preserved — the main window's pane geometry (positions +
    //    sizes) matches the saved layout. tmux's layout string includes
    //    pane ids, which change after a swap, so we strip ids before
    //    comparing: the geometry skeleton (cell sizes + offsets) is the
    //    invariant we care about.
    const currentLayout = tmuxCapture([
      "display-message",
      "-p",
      "-t",
      `${session}:kobe`,
      "#{window_visible_layout}",
    ])
    expect(stripPaneIds(currentLayout)).toBe(stripPaneIds(savedLayout))

    // 8. Kill paneA (currently in stash, since tab2 is displayed).
    await adapter.killForTab("taskA", "tab1")
    stashPanes = await client.listPanes({ target: stashTarget, format: "#{pane_id}" })
    mainPanes = await client.listPanes({ target: `${session}:kobe`, format: "#{pane_id}" })
    expect(stashPanes).not.toContain(paneA)
    expect(mainPanes).not.toContain(paneA)
  },
  30_000,
)

/**
 * tmux layout strings look like `<checksum>,<wxh>,<x>,<y>,<paneId>[…]`.
 * Pane ids change after a swap, so we strip the trailing pane-id digits
 * from each comma-segment to compare just the geometry skeleton.
 */
function stripPaneIds(layout: string): string {
  // Drop the leading checksum (first comma) — it changes with pane ids
  // and is informational only.
  const noChecksum = layout.replace(/^[0-9a-fA-F]+,/, "")
  // Replace every standalone numeric run that follows the pattern of a
  // pane-id leaf (`,<digits>` at the end of a segment) with `,N`. Pane
  // ids are the last comma-separated field of each leaf.
  return noChecksum.replace(/,(\d+)(?=[\],}]|$)/g, ",N")
}
