/**
 * Heal/respawn machinery for kobe-owned panes in a live task session.
 *
 * kobe updates leave existing tmux sessions alive — correct for engine
 * panes (they may be mid-turn), but the Tasks/Ops panes are also
 * long-lived `kobe tasks` / `kobe ops` processes, so they keep running
 * the OLD binary until something restarts them. CLAUDE.md documents the
 * contract this module exists for: "use it after Tasks-pane / Ops-pane /
 * engine changes so a long-lived session isn't still running old pane
 * code" — kobe-owned panes are version-tagged ({@link PANE_VERSION_OPTION})
 * and respawned **in place** (`respawn-pane` preserves the pane id, so the
 * Ops pane's `--target-pane` and every `@kobe_role` lookup stay valid; the
 * engine pane and all ChatTab windows stay alive).
 *
 * Three respawn surfaces share the machinery:
 *
 *   - {@link healWorkspaceLayout} (with `versions` passed) — stale-version
 *     Tasks/Ops respawns, applied by `ensureSession` on every reuse/respawn
 *     outcome alongside the layout re-pin, all from one pane snapshot.
 *   - {@link refreshKobeWorkspacePanes} — unconditional Tasks/Ops respawns
 *     after a settings change (`kobe reload`, Settings page exit).
 *   - {@link relaunchEngineInAllWindows} — the vendor-switch engine
 *     respawn, here because it is the same "respawn in place,
 *     keep pane ids" move aimed at the engine pane instead.
 *
 * The WHICH-panes policy is pure ({@link parseKobePaneRows},
 * {@link paneIdsByRole}, {@link planPaneHeals} — unit-tested without a tmux
 * server, the same seam style as `tmux/session-decision.ts`); only the
 * list/respawn calls touch the real server.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import { withClaudeSessionId } from "@/engine/interactive-command"
import { localSpawnCwd } from "@/exec/resolve"
import {
  CHAT_TAB_SESSION_ID_OPTION,
  getSessionOptions,
  readLayoutGeometry,
  runTmuxCapturing,
  runTmuxSequence,
  sessionExists,
} from "@/tmux/client"
import {
  HIDDEN_TASKS_PANE_OPTION,
  HIDDEN_TERMINAL_PANE_OPTION,
  OPS_HEIGHT_OPTION,
  RIGHT_COLUMN_WIDTH_OPTION,
  TASKS_WIDTH_OPTION,
  clampPanePercent,
  clampTasksPaneWidth,
  engineTabExitCleanup,
  keepAlive,
  opsPaneCommand,
  shellQuoteArgv,
  tasksPaneCommand,
} from "@/tmux/session-layout"
import { applyTmuxChromeTheme } from "@/tui/lib/tmux-border-theme"
import { CURRENT_VERSION } from "@/version"
import { inheritedEnvPrefix, wrapEngineLaunch } from "./launch"
import { recordGen } from "./layout-coord"

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
const KOBE_PANE_LIST_FORMAT = `#{window_id}\t#{pane_id}\t#{@kobe_role}\t#{${PANE_VERSION_OPTION}}\t#{pane_width}`

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
 * Why this exists: {@link listKobePanes} reads a pane snapshot, then a single
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
 *     store (dead `● new` badge + wrong tab-bar turn state). Tasks panes
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

/** Session-wide kobe pane snapshot; `null` when the listing fails. */
async function listKobePanes(session: string): Promise<KobePaneRow[] | null> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-s",
    "-t",
    `=${session}`,
    "-F",
    KOBE_PANE_LIST_FORMAT,
  ])
  if (code !== 0) return null
  return parseKobePaneRows(stdout)
}

/**
 * Run a best-effort heal batch, but first drop any command whose target pane
 * vanished since the snapshot the batch was built from (see
 * {@link dropCommandsForVanishedPanes}). A fresh `list-panes` immediately before
 * exec shrinks the snapshot→exec window to near zero so one since-closed pane
 * can't abort the heal of the others. Pre-validation (vs per-command tolerance)
 * fits how heals run here: tmux has no "continue past a failed command" within a
 * single `cmd ; cmd …` sequence, and splitting into one invocation per pane
 * would lose both the preserved ordering and the single batched repaint the
 * layout heal relies on.
 *
 * Only re-lists when there is work to do, so a healthy heal (no commands —
 * panes already at the target width and version) keeps its exact behavior and
 * spawn count. If the re-list itself fails (server gone), it runs the batch
 * unfiltered — same exposure as before this guard existed, never worse.
 */
async function runHealBatchTolerant(session: string, commands: readonly (readonly string[])[]): Promise<void> {
  if (commands.length === 0) return
  const present = await listKobePanes(session)
  const filtered = present ? dropCommandsForVanishedPanes(commands, new Set(present.map((r) => r.paneId))) : commands
  if (filtered.length > 0) await runTmuxSequence(filtered)
}

/**
 * tmux command triples for a heal plan: respawn the pane in place
 * (`-k` kills the old kobe process), then re-assert its `@kobe_role`
 * tag and stamp the new {@link PANE_VERSION_OPTION}.
 */
function respawnCommandsFor(
  targets: readonly PaneHealTarget[],
  args: { cwd: string; taskId: string | undefined; vendor: string | undefined },
): (readonly string[])[] {
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const commands: (readonly string[])[] = []
  for (const target of targets) {
    const paneCommand =
      target.role === "tasks"
        ? tasksPaneCommand(inv, { initialTaskId: args.taskId })
        : opsPaneCommand({
            cwd: args.cwd,
            taskId: args.taskId,
            claudePaneId: target.claudePaneId,
            cliInvocation: inv,
            vendor: args.vendor,
          })
    commands.push(
      ["respawn-pane", "-k", "-t", target.paneId, "-c", localSpawnCwd(args.cwd), keepAlive(envPrefix + paneCommand)],
      ["set-option", "-p", "-t", target.paneId, "@kobe_role", target.role],
      ["set-option", "-p", "-t", target.paneId, PANE_VERSION_OPTION, CURRENT_VERSION],
    )
  }
  return commands
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
 * Relaunch the engine (claude/codex) pane in EVERY window of the session
 * in place via `respawn-pane`, preserving the windows and their other
 * panes (and each pane's id + `@kobe_role` tag, so the Ops pane's
 * `--target-pane` keeps pointing at a live pane). Returns a
 * {@link RelaunchEngineResult}: `"switched"` only when ALL windows respawned
 * cleanly, `"no-engine-pane"` when none was found (caller rebuilds), or
 * `"respawn-failed"` when the batched respawn reported a tmux error (caller
 * leaves the prior `@kobe_vendor` tag rather than falsely claiming the switch).
 * Used to apply a vendor switch to a multi-window session without
 * `kill-session` dropping sibling chat tabs.
 *
 * Engine identity is re-woven PER WINDOW, exactly like the two fresh launch
 * paths (`ensureSession`'s create branch + `newChatTab`). The pre-fix code
 * respawned with the raw `command`, which left the new engine running with no
 * `--session-id` while each window's stale `@kobe_session_id` still held the
 * PRE-switch UUID — so the chat-tab auto-namer resolved the OLD vendor's
 * transcript (wrong or empty names). Now each window gets its OWN fresh
 * `withClaudeSessionId(command, vendor)` weave (a distinct UUID per window for
 * claude; identity for codex/copilot), and its `@kobe_session_id` window option
 * is re-pinned to that id — or CLEARED when the new vendor can't take a
 * caller-set id, so no stale claude UUID lingers to mis-name the tab.
 */
export async function relaunchEngineInAllWindows(
  session: string,
  cwd: string,
  command: readonly string[],
  remoteKey?: string,
  vendor?: string,
): Promise<RelaunchEngineResult> {
  const rows = await listKobePanes(session)
  if (!rows) return "no-engine-pane"
  // Each engine pane carries its window id, so we can re-pin that window's
  // `@kobe_session_id` to the freshly woven UUID. `paneIdsByRole` would drop
  // the window id, so filter the rows directly (first claude pane per row order
  // — there is one engine pane per window).
  const enginePanes = rows.filter((r) => r.role === "claude")
  if (enginePanes.length === 0) return "no-engine-pane"
  const localCwd = localSpawnCwd(cwd)
  const cleanup = engineTabExitCleanup(inheritedEnvPrefix(), kobeCliInvocation(), session)
  const commands: (readonly string[])[] = []
  for (const pane of enginePanes) {
    // Fresh identity per window — a distinct `--session-id` UUID for claude so
    // each tab maps to its own transcript; `null` for codex/copilot.
    const launch = withClaudeSessionId(command, vendor)
    const cmd = keepAlive(wrapEngineLaunch(shellQuoteArgv(launch.argv), remoteKey, cwd), cleanup)
    // `-k` kills the old engine process; `-c` is the LOCAL spawn dir (the
    // worktree is remote for a remote task — the wrapped ssh carries `cd <wt>`).
    commands.push(["respawn-pane", "-k", "-c", localCwd, "-t", pane.paneId, cmd])
    // Re-pin (claude) or clear (codex/copilot) this window's recorded session id
    // so the auto-namer reads the RIGHT transcript store with the RIGHT id.
    // `set-window-option` targets the window via any pane inside it; the pane id
    // survives `respawn-pane`.
    commands.push(
      launch.sessionId
        ? ["set-window-option", "-t", pane.paneId, CHAT_TAB_SESSION_ID_OPTION, launch.sessionId]
        : ["set-window-option", "-u", "-t", pane.paneId, CHAT_TAB_SESSION_ID_OPTION],
    )
  }
  // One tmux invocation for all windows. tmux runs `cmd ; cmd …` in order and
  // HALTS on the first failure, exiting non-zero — so a single aggregate exit
  // code is a faithful all-or-nothing signal: zero means every window's engine
  // pane respawned, non-zero means at least one did not (and the windows after
  // it never ran). The caller uses this to decide whether to advance the
  // session's single `@kobe_vendor` tag, so a partial respawn can't leave the
  // tag claiming a vendor that some window isn't actually running.
  const code = await runTmuxSequence(commands)
  return classifyRelaunchOutcome(enginePanes.length, code)
}

/** The user's global right-column geometry as `resize-pane` args (empty when unset). */
export async function globalRightColumnResizeArgs(): Promise<readonly string[]> {
  return (await readLayoutGeometry()).rightColumnResizeArgs
}

/**
 * One-snapshot heal for a live session, run on every session build/reuse
 * (every task switch / re-attach) and from the `window-resized` hook:
 *
 *   1. Force every Tasks rail to the global width. The point is cross-task
 *      CONSISTENCY: the rail is one shared size, so switching never changes
 *      its width. The size itself is user-adjustable — a manual drag is
 *      captured into the global option on switch-away
 *      ({@link captureGlobalLayout}) and re-applied here, which is what makes
 *      a resize "stick" everywhere. Idempotent: panes already at the target
 *      width are skipped, so a healthy switch issues no resize.
 *   2. Apply the user's global right-column geometry to every window. The
 *      right column is the Ops (file-tree) pane stacked over the terminal;
 *      one `resize-pane` on the Ops pane sets BOTH boundaries: `-x` (column
 *      width) pulls from the Claude chat pane (the Tasks rail stays fixed),
 *      `-y` (file-tree height) pulls from the terminal below. No-op when
 *      neither option is set — a user who never dragged keeps the default.
 *   3. (only when `versions` is passed) respawn kobe-owned Tasks/Ops panes
 *      whose version tag is absent or stale — see {@link planPaneHeals} —
 *      so newly shipped pane code doesn't appear "missing" until a manual
 *      tmux reset. The reuse/respawn outcomes of `ensureSession` pass this;
 *      the pre-attach/layout-hook callers don't (they must never kill a
 *      pane process).
 *
 * All three decisions read the SAME `list-panes -s` snapshot and the same
 * batched server-option read, and every mutation lands in ONE tmux
 * invocation — 2 spawns on a healthy reuse where the pre-batch chain
 * (`healTaskPaneWidths` + `healRightColumn` + `healKobePaneVersions`)
 * spawned 6 reads plus up to 3 mutation sequences.
 */
/**
 * Plan the rail + right-column re-pin commands for a session's workspace panes
 * WITHOUT running them — the pure layout half of {@link healWorkspaceLayout},
 * factored out so a caller that ALSO resizes the window (the `client-resized`
 * resync) can batch the window resize and these pane re-pins into ONE tmux
 * command sequence. tmux then applies both and repaints once, so the rail never
 * flashes through its proportionally-reflowed (blown-up) intermediate width.
 *
 * `force` skips the "only if it differs" guard. After a `resize-window` the rail
 * WILL have been reflowed proportionally wider, but a batched caller plans these
 * commands from the PRE-resize snapshot (the rail still reads its already-pinned
 * width), so the guard would wrongly skip the re-pin and leave the rail blown
 * up. Callers that plan against already-settled geometry (the window-resized /
 * reuse heals) keep the guard to avoid redundant churn.
 */
export async function workspaceLayoutPaneCommands(
  session: string,
  opts: { readonly force?: boolean } = {},
): Promise<{ rows: KobePaneRow[] | null; commands: (readonly string[])[] }> {
  const { tasksWidth, rightColumnResizeArgs: rcArgs } = await readLayoutGeometry()
  const rows = await listKobePanes(session)
  if (!rows) return { rows: null, commands: [] }
  const commands: (readonly string[])[] = []
  for (const row of rows) {
    if (row.role === "tasks" && (opts.force || row.paneWidth !== tasksWidth)) {
      commands.push(["resize-pane", "-t", row.paneId, "-x", `${tasksWidth}`])
    }
  }
  if (rcArgs.length > 0) {
    for (const row of rows) {
      if (row.role === "ops") commands.push(["resize-pane", "-t", row.paneId, ...rcArgs])
    }
  }
  return { rows, commands }
}

export async function healWorkspaceLayout(
  session: string,
  versions?: { cwd: string; taskId: string | undefined; vendor: string | undefined; vendorChanged?: boolean },
): Promise<void> {
  // Stamp the `resize` recency marker before this heal's `resize-pane` fires
  // `window-layout-changed`: the capture hook's guard (genAgeMs(session,
  // "resize")) then sees a fresh stamp and skips, so a reflow this heal is
  // fixing is never mis-captured as a manual drag. This is the single choke
  // point every heal path funnels through (hook, reuse, pre-switch/attach).
  recordGen(session, "resize")
  const { rows, commands: planned } = await workspaceLayoutPaneCommands(session)
  if (!rows) return
  const commands: (readonly string[])[] = [...planned]
  if (versions) {
    commands.push(
      ...respawnCommandsFor(
        planPaneHeals(rows, {
          currentVersion: CURRENT_VERSION,
          force: false,
          // After an in-place vendor switch, force the Ops panes to respawn so
          // their baked `--vendor` flag (and the transcript store the activity
          // badge / turn detector poll) match the new engine.
          vendorChanged: versions.vendorChanged,
        }),
        versions,
      ),
    )
  }
  // Re-validate pane existence right before the batch runs: a pane the user
  // closed between the snapshot above and now would otherwise abort the heal of
  // every later pane (tmux halts the sequence on the first failed respawn).
  await runHealBatchTolerant(session, commands)
}

/**
 * Re-pin a session's whole layout (Tasks rail width + right-column geometry) to
 * the shared globals. This is the layout half of {@link healWorkspaceLayout}
 * (no version respawns), exposed for the `window-resized` tmux hook.
 *
 * Why a hook: the FIRST task session is built detached (no client attached yet),
 * so tmux sizes its window to a default/stale size; the real terminal size only
 * lands when `tmux attach` connects, at which point tmux reflows every pane
 * PROPORTIONALLY — blowing up the absolute-width Tasks rail and shifting the
 * right column. Reuse heals later switches, but the first attach had no heal, so
 * the very first view was off until the user switched once. The hook fires on
 * `window-resized` (after the window settles to the new size — `client-attached`
 * fires BEFORE the attach resize and would heal against the stale size), so it
 * also re-pins on any live terminal resize. No-op for the home session (no
 * role-tagged panes).
 */
export async function healSessionLayout(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  await healWorkspaceLayout(session)
}

/**
 * Persist a session's CURRENT (active-window) pane geometry as the new global
 * layout, so a manual resize in one task becomes the shared shape every other
 * task uses. Called when switching AWAY from a task. Captures the Tasks-rail
 * width (cells) and the right column's width + file-tree height (each as a % of
 * the window, the unit {@link healWorkspaceLayout} re-applies with). Each axis is
 * skipped if unreadable; values are clamped before they are stored.
 *
 * Bails if any pane is zoomed: a zoomed pane reports the full-window grid, so
 * the right-column width reads back as ~100% and would poison the global until
 * the next real drag. The drag path gates on this via {@link shouldCaptureDrag},
 * but the switch-away caller hits this function directly, so the guard lives
 * here too.
 */
export async function captureGlobalLayout(session: string): Promise<void> {
  // No `-s`: the active window's panes — the ones the user can see and drag.
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-t",
    `=${session}`,
    "-F",
    `#{@kobe_role}\t#{pane_width}\t#{pane_height}\t#{window_width}\t#{window_height}\t#{window_zoomed_flag}\t#{${HIDDEN_TERMINAL_PANE_OPTION}}\t#{${HIDDEN_TASKS_PANE_OPTION}}`,
  ])
  if (code !== 0) return
  const rows = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => (cols[0]?.trim() ?? "") !== "")
  if (rows.length === 0) return
  if (rows.some((cols) => cols[5]?.trim() === "1")) return // zoomed → geometry is unreliable
  if (rows.some((cols) => (cols[6]?.trim() ?? "") !== "")) return // hidden shell → Ops is temporarily full-height
  if (rows.some((cols) => (cols[7]?.trim() ?? "") !== "")) return // hidden Tasks → remaining panes are temporarily full-width
  // Shell pane CLOSED (user typed `exit` in the bottom-right terminal — it has no
  // keepAlive, so it really dies) rather than hidden-by-toggle (caught above via
  // HIDDEN_TERMINAL_PANE_OPTION). With the shell gone, Ops has grown to fill the
  // right column, so its height reads back as ~100% — capturing that would poison
  // the global Ops height for EVERY task until the next manual drag. Bail.
  if (!rows.some((cols) => cols[0]?.trim() === "shell")) return
  const winW = Number.parseInt(rows[0][3]?.trim() ?? "", 10)
  const winH = Number.parseInt(rows[0][4]?.trim() ?? "", 10)
  const sets: (readonly string[])[] = []
  const tasks = rows.find(([role]) => role?.trim() === "tasks")
  if (tasks) {
    const width = Number.parseInt(tasks[1]?.trim() ?? "", 10)
    if (Number.isFinite(width) && width > 0)
      sets.push(["set-option", "-s", TASKS_WIDTH_OPTION, `${clampTasksPaneWidth(width)}`])
  }
  const ops = rows.find(([role]) => role?.trim() === "ops")
  if (ops && Number.isFinite(winW) && winW > 0 && Number.isFinite(winH) && winH > 0) {
    const opsW = Number.parseInt(ops[1]?.trim() ?? "", 10)
    const opsH = Number.parseInt(ops[2]?.trim() ?? "", 10)
    const widthPct = Number.isFinite(opsW) ? clampPanePercent((100 * opsW) / winW) : null
    const heightPct = Number.isFinite(opsH) ? clampPanePercent((100 * opsH) / winH) : null
    if (widthPct !== null) sets.push(["set-option", "-s", RIGHT_COLUMN_WIDTH_OPTION, `${widthPct}`])
    if (heightPct !== null) sets.push(["set-option", "-s", OPS_HEIGHT_OPTION, `${heightPct}`])
  }
  if (sets.length > 0) await runTmuxSequence(sets)
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
 * ({@link genAgeMs}); this gate only covers what a stable-size layout change
 * can still get wrong.
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

/**
 * Capture the active window's geometry as the new global layout ONLY when the
 * `window-layout-changed` that triggered us is a genuine user drag — see
 * {@link shouldCaptureDrag}. This is the live counterpart to the switch-away
 * {@link captureGlobalLayout}: it persists a rail / right-column drag the
 * MOMENT it happens, so a later terminal resize (whose `window-resized` heal
 * re-pins every pane to the global) can't silently discard a drag the user
 * made but hadn't yet "committed" by switching tasks.
 */
export async function captureGlobalLayoutOnDrag(session: string): Promise<void> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-t",
    `=${session}`,
    "-F",
    `#{@kobe_role}\t#{window_zoomed_flag}\t#{${HIDDEN_TERMINAL_PANE_OPTION}}\t#{${HIDDEN_TASKS_PANE_OPTION}}`,
  ])
  if (code !== 0 || !shouldCaptureDrag(stdout)) return
  await captureGlobalLayout(session)
}

/**
 * Settings changes are read by each kobe-owned pane process at startup.
 * After the full-window Settings page exits, the existing Tasks/Ops panes
 * in sibling ChatTabs are still alive, so respawn only those helper panes
 * in place to make the new prefs visible without touching the user's
 * engine or shell panes.
 *
 * Scope note (KOB — live theme propagation): the VISUAL prefs (theme /
 * transparent / focus accent) no longer depend on this respawn — every
 * pane re-applies them live from the daemon's `ui-prefs` channel
 * (host-boot's UiPrefsSync), across ALL sessions. This refresh stays
 * because it still serves everything else: NON-visual prefs each pane's
 * KVProvider snapshotted at boot (notification toggles, settings surface,
 * editor kind, …) and the no-daemon degraded mode. It also remains the
 * single owner of the tmux chrome re-style below — the tmux status/window
 * bar and border options are server-global, so this one call after a Settings
 * exit covers every session; applying them from each pane's live-prefs hook
 * would just race the same `set-option`s.
 */
export async function refreshKobeWorkspacePanes(session: string): Promise<void> {
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree", "@kobe_task", "@kobe_vendor"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const taskId = sessionOptions["@kobe_task"] || undefined
  const vendor = sessionOptions["@kobe_vendor"] || undefined
  const rows = await listKobePanes(session)
  if (!rows) return
  const commands = respawnCommandsFor(planPaneHeals(rows, { currentVersion: CURRENT_VERSION, force: true }), {
    cwd,
    taskId,
    vendor,
  })
  // Same vanished-pane guard as healWorkspaceLayout: a sibling ChatTab closed
  // between the snapshot and now must not abort the respawn of the others.
  await runHealBatchTolerant(session, commands)

  // The Appearance prefs the respawned panes just re-read also drive tmux
  // chrome — re-derive those in the same pass so a theme switch restyles
  // the status/window bar and pane separators without a new session build.
  await applyTmuxChromeTheme()
}
