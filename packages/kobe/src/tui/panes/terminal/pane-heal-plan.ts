/**
 * The pure WHICH-panes policy behind pane-heal.ts — parsing pane snapshots,
 * planning respawns, classifying relaunch outcomes, and gating drag captures.
 * Same rows → same plan; unit-tested without a tmux server (the same seam
 * style as `tmux/session-decision.ts`). The effectful list/respawn/heal
 * machinery lives in pane-heal.ts.
 */

/** Pane user-option tagging which kobe version spawned a kobe-owned pane. */
export const PANE_VERSION_OPTION = "@kobe_pane_version"

/** One pane of a session-wide `list-panes` snapshot, as kobe reads it. */
export type KobePaneRow = {
  windowId: string
  paneId: string
  role: string
  version: string
  /**
   * Geometry columns (cells) — present only when the listing used the
   * geometry-extended format ({@link KOBE_PANE_LIST_FORMAT}); absent on the
   * legacy 4-field shape. `undefined` (not 0) when a field is missing or
   * unparsable, so a degraded row still heals: a width that can't be read
   * compares unequal to any target and gets the resize, same as before.
   */
  paneWidth?: number
}

/**
 * The one `list-panes -F` format every heal surface reads. One snapshot
 * serves all three heal questions per session build/reuse — rail width
 * (`pane_width`), right-column geometry (role), and stale kobe-pane
 * versions — instead of the three near-identical `list-panes -s` spawns
 * the pre-batch heals each issued.
 */
export const KOBE_PANE_LIST_FORMAT = `#{window_id}\t#{pane_id}\t#{@kobe_role}\t#{${PANE_VERSION_OPTION}}\t#{pane_width}`

/** Parse `list-panes -F KOBE_PANE_LIST_FORMAT` output. Pure. */
export function parseKobePaneRows(stdout: string): KobePaneRow[] {
  const rows: KobePaneRow[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const [windowId, paneId, role, version, paneWidth] = line.split("\t")
    if (!windowId || !paneId || !role) continue
    const width = Number.parseInt(paneWidth?.trim() ?? "", 10)
    rows.push({
      windowId: windowId.trim(),
      paneId: paneId.trim(),
      role: role.trim(),
      version: version?.trim() ?? "",
      ...(Number.isFinite(width) ? { paneWidth: width } : {}),
    })
  }
  return rows
}

/** Pane ids carrying a given `@kobe_role` tag, in listing order. Pure. */
export function paneIdsByRole(rows: readonly KobePaneRow[], role: string): string[] {
  return rows.filter((row) => row.role === role).map((row) => row.paneId)
}

/**
 * The pane id a heal command targets — the value after its `-t` flag — or
 * `null` when it targets no pane. Every heal command in this module is
 * pane-scoped (`respawn-pane`/`resize-pane`/`set-option -p`/`set-window-option`
 * all carry exactly one `-t <pane>`), so this is the key a vanished-pane filter
 * keys on. Pure.
 */
export function commandTargetPane(command: readonly string[]): string | null {
  const i = command.indexOf("-t")
  return i >= 0 && i + 1 < command.length ? (command[i + 1] ?? null) : null
}

/**
 * Drop heal commands whose target pane is no longer present, given the set of
 * pane ids that still exist. Pure so the planning half is unit-testable without
 * a tmux server.
 *
 * Why this exists: `listKobePanes` reads a pane snapshot, then a single
 * batched `cmd ; cmd …` tmux sequence respawns/resizes those panes. tmux runs
 * the sequence in order and HALTS on the first failure — so if a pane was closed
 * (tab close / task delete) between the snapshot and execution, its
 * `respawn-pane -t <gone>` errors and every LATER command in the batch never
 * runs, leaving the still-present panes unhealed until the next tick. Filtering
 * the batch to the panes that still exist lets the rest heal this tick while
 * preserving the original ORDER and the single batched repaint. A command that
 * targets no pane (none today, but defensive) is always kept. Best-effort, not a
 * transaction: a pane that vanishes AFTER this filter still aborts the tail, but
 * that window self-heals next tick.
 */
export function dropCommandsForVanishedPanes(
  commands: readonly (readonly string[])[],
  presentPaneIds: ReadonlySet<string>,
): (readonly string[])[] {
  return commands.filter((cmd) => {
    const target = commandTargetPane(cmd)
    return target === null || presentPaneIds.has(target)
  })
}

/** One kobe-owned pane {@link planPaneHeals} decided to respawn in place. */
export type PaneHealTarget =
  | { readonly role: "tasks"; readonly paneId: string }
  | { readonly role: "ops"; readonly paneId: string; readonly claudePaneId: string | null }

/**
 * Decide WHICH kobe-owned panes to respawn. Pure: same rows → same plan.
 *
 * Per window (first pane of each role wins, matching the pre-extraction
 * `find`-based code):
 *
 *   - `force: false` (the upgrade heal): respawn a Tasks/Ops pane only
 *     when its version tag differs from `currentVersion`, and an Ops pane
 *     only when its window still has a live claude pane to target.
 *   - `force: true` (settings refresh): respawn every Tasks/Ops pane
 *     regardless of version. The Ops pane is respawned even in a degraded
 *     window with NO claude pane (`claudePaneId: null`) — `opsPaneCommand`
 *     already degrades to its git-status fallback, and skipping it
 *     silently left the pane on stale code after a `kobe reload`.
 *   - `vendorChanged: true` (the vendor-switch heal): respawn
 *     every OPS pane that still has a live claude pane regardless of
 *     version — the Ops pane bakes its `--vendor` flag at spawn time
 *     (`opsPaneCommand`), so on an in-place engine switch a same-version
 *     Ops pane would otherwise keep polling the OLD vendor's transcript
 *     store (wrong tab-bar turn state). Tasks panes
 *     are version-gated as usual (the Tasks rail is vendor-agnostic).
 */
export function planPaneHeals(
  rows: readonly KobePaneRow[],
  opts: { readonly currentVersion: string; readonly force: boolean; readonly vendorChanged?: boolean },
): PaneHealTarget[] {
  const byWindow = new Map<string, KobePaneRow[]>()
  for (const row of rows) {
    const panes = byWindow.get(row.windowId) ?? []
    panes.push(row)
    byWindow.set(row.windowId, panes)
  }

  const targets: PaneHealTarget[] = []
  for (const panes of byWindow.values()) {
    const claudePane = panes.find((pane) => pane.role === "claude")?.paneId
    const tasksPane = panes.find((pane) => pane.role === "tasks")
    const opsPane = panes.find((pane) => pane.role === "ops")

    if (tasksPane && (opts.force || tasksPane.version !== opts.currentVersion)) {
      targets.push({ role: "tasks", paneId: tasksPane.paneId })
    }
    // Force-respawn this window's Ops pane on a vendor change too — but only
    // when its window still has a live claude pane (it always does right after
    // a successful engine respawn). The unconditional `force` path keeps its
    // degraded-window behavior (respawn even with no claude pane).
    const opsNeedsRespawn = opts.force
      ? true
      : claudePane && (opts.vendorChanged || opsPane?.version !== opts.currentVersion)
    if (opsPane && opsNeedsRespawn) {
      targets.push({ role: "ops", paneId: opsPane.paneId, claudePaneId: claudePane ?? null })
    }
  }
  return targets
}

/**
 * Outcome of an in-place engine respawn across all windows:
 *   - `"switched"` — every window's engine pane respawned on the new vendor;
 *     the caller may now advance the session's `@kobe_vendor` tag.
 *   - `"no-engine-pane"` — no engine pane was found to respawn; the caller
 *     falls back to a full session rebuild.
 *   - `"respawn-failed"` — engine panes were found but the batched respawn
 *     reported a tmux error, so the switch did NOT fully land. The caller must
 *     NOT advance `@kobe_vendor` (it would then claim a vendor that isn't
 *     running in the windows that failed); the stale tag drives a retry on the
 *     next `ensureSession`.
 */
export type RelaunchEngineResult = "switched" | "no-engine-pane" | "respawn-failed"

/**
 * Classify a vendor-switch respawn from the two facts the applier observes:
 * how many engine panes were found, and the exit code of the SINGLE batched
 * respawn invocation. Pure so the all-or-nothing aggregation — a partial
 * respawn must never advance the `@kobe_vendor` tag — is unit-testable without
 * a live tmux server. tmux halts a `cmd ; cmd …` sequence on the first failure
 * and exits non-zero, so a non-zero code means at least one window's engine
 * respawn did not land.
 */
export function classifyRelaunchOutcome(enginePaneCount: number, sequenceExitCode: number): RelaunchEngineResult {
  if (enginePaneCount === 0) return "no-engine-pane"
  return sequenceExitCode === 0 ? "switched" : "respawn-failed"
}

/**
 * Decide whether a `window-layout-changed` firing is a genuine USER drag we
 * should capture, from a
 * `#{@kobe_role}\t#{window_zoomed_flag}\t#{@kobe_hidden_shell_pane}\t#{@kobe_hidden_tasks_pane}`
 * listing of the active window. Pure so the gate is unit-testable without a
 * tmux server. The hidden-state columns are optional for older tests/callers.
 *
 * Capture only when the layout change is safe to read as the user's intended
 * geometry:
 *   - NOT zoomed — a zoomed pane reports the full-window grid, so the rail /
 *     right-column widths read back as garbage; capturing them would poison
 *     the global until the next real drag.
 *   - the full kobe role set is present (`tasks` + `ops` + `shell`) — excludes
 *     the transient half-built layouts that pane splits emit during a session
 *     build / respawn, where the geometry isn't the user's to keep, AND the case
 *     where the user closed the bottom-right shell pane via `exit` (it has no
 *     keepAlive, so it dies): Ops then fills the right column and its height
 *     would read back as ~100%, poisoning the global Ops height. The hidden-by-
 *     toggle case is caught separately by the hidden-state columns below.
 *   - terminal is not hidden in a background tmux window — when hidden, the
 *     Ops pane temporarily fills the right column and would poison the saved
 *     Ops height.
 *   - Tasks is not hidden in a background tmux window — when hidden, the
 *     remaining workspace panes temporarily fill the full width and would
 *     poison the saved Tasks/right-column geometry.
 *
 * The resize-reflow case (where the rail is proportionally blown up and must
 * NOT be captured) is excluded earlier by the caller's resize-recency guard
 * (`genAgeMs`); this gate only covers what a stable-size layout change can
 * still get wrong.
 */
export function shouldCaptureDrag(stdout: string): boolean {
  const rows = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => (cols[0]?.trim() ?? "") !== "")
  if (rows.length === 0) return false
  if (rows.some((cols) => cols[1]?.trim() === "1")) return false // any pane zoomed
  if (rows.some((cols) => (cols[2]?.trim() ?? "") !== "")) return false
  if (rows.some((cols) => (cols[3]?.trim() ?? "") !== "")) return false
  const roles = new Set(rows.map((cols) => cols[0]?.trim()))
  return roles.has("tasks") && roles.has("ops") && roles.has("shell")
}
