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
 *     respawn (KOB-232), here because it is the same "respawn in place,
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
  getServerOptions,
  getSessionOptions,
  runTmuxCapturing,
  runTmuxSequence,
  sessionExists,
} from "@/tmux/client"
import {
  OPS_HEIGHT_OPTION,
  RIGHT_COLUMN_WIDTH_OPTION,
  TASKS_PANE_WIDTH,
  TASKS_WIDTH_OPTION,
  clampPanePercent,
  clampTasksPaneWidth,
  keepAlive,
  opsPaneCommand,
  shellQuoteArgv,
  tasksPaneCommand,
} from "@/tmux/session-layout"
import { applyTmuxPaneBorderTheme } from "@/tui/lib/tmux-border-theme"
import { CURRENT_VERSION } from "@/version"
import { inheritedEnvPrefix, wrapEngineLaunch } from "./launch"

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
 *   - `vendorChanged: true` (the vendor-switch heal, KOB-232): respawn
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
 * Relaunch the engine (claude/codex) pane in EVERY window of the session
 * in place via `respawn-pane`, preserving the windows and their other
 * panes (and each pane's id + `@kobe_role` tag, so the Ops pane's
 * `--target-pane` keeps pointing at a live pane). Returns `true` if at
 * least one engine pane was respawned, `false` if none was found (caller
 * then falls back to a full rebuild). Used to apply a vendor switch to a
 * multi-window session without `kill-session` dropping sibling chat tabs
 * (KOB-232).
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
): Promise<boolean> {
  const rows = await listKobePanes(session)
  if (!rows) return false
  // Each engine pane carries its window id, so we can re-pin that window's
  // `@kobe_session_id` to the freshly woven UUID. `paneIdsByRole` would drop
  // the window id, so filter the rows directly (first claude pane per row order
  // — there is one engine pane per window).
  const enginePanes = rows.filter((r) => r.role === "claude")
  if (enginePanes.length === 0) return false
  const localCwd = localSpawnCwd(cwd)
  const commands: (readonly string[])[] = []
  for (const pane of enginePanes) {
    // Fresh identity per window — a distinct `--session-id` UUID for claude so
    // each tab maps to its own transcript; `null` for codex/copilot.
    const launch = withClaudeSessionId(command, vendor)
    const cmd = keepAlive(wrapEngineLaunch(shellQuoteArgv(launch.argv), remoteKey, cwd))
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
  // One tmux invocation for all windows (per-pane exit codes were never
  // consulted here, so batching loses no error detection).
  await runTmuxSequence(commands)
  return true
}

/** The user's global layout prefs (rail width + right-column %), ONE tmux spawn. */
async function globalLayoutPrefs(): Promise<{ tasksWidth: number; rcArgs: string[] }> {
  const opts = await getServerOptions([TASKS_WIDTH_OPTION, RIGHT_COLUMN_WIDTH_OPTION, OPS_HEIGHT_OPTION])
  const rawWidth = Number.parseInt(opts[TASKS_WIDTH_OPTION] ?? "", 10)
  const tasksWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? clampTasksPaneWidth(rawWidth) : TASKS_PANE_WIDTH
  const rcArgs = rightColumnResizeArgs({
    widthPct: clampPanePercent(Number.parseInt(opts[RIGHT_COLUMN_WIDTH_OPTION] ?? "", 10)),
    heightPct: clampPanePercent(Number.parseInt(opts[OPS_HEIGHT_OPTION] ?? "", 10)),
  })
  return { tasksWidth, rcArgs }
}

/** Build the `resize-pane -x/-y N%` args for an Ops pane from a geometry pair. */
function rightColumnResizeArgs(geom: { widthPct: number | null; heightPct: number | null }): string[] {
  const args: string[] = []
  if (geom.widthPct !== null) args.push("-x", `${geom.widthPct}%`)
  if (geom.heightPct !== null) args.push("-y", `${geom.heightPct}%`)
  return args
}

/** The user's global right-column geometry as `resize-pane` args (empty when unset). */
export async function globalRightColumnResizeArgs(): Promise<string[]> {
  return (await globalLayoutPrefs()).rcArgs
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
export async function healWorkspaceLayout(
  session: string,
  versions?: { cwd: string; taskId: string | undefined; vendor: string | undefined; vendorChanged?: boolean },
): Promise<void> {
  const { tasksWidth, rcArgs } = await globalLayoutPrefs()
  const rows = await listKobePanes(session)
  if (!rows) return
  const commands: (readonly string[])[] = []
  for (const row of rows) {
    if (row.role === "tasks" && row.paneWidth !== tasksWidth) {
      commands.push(["resize-pane", "-t", row.paneId, "-x", `${tasksWidth}`])
    }
  }
  if (rcArgs.length > 0) {
    for (const row of rows) {
      if (row.role === "ops") commands.push(["resize-pane", "-t", row.paneId, ...rcArgs])
    }
  }
  if (versions) {
    commands.push(
      ...respawnCommandsFor(
        planPaneHeals(rows, {
          currentVersion: CURRENT_VERSION,
          force: false,
          // After an in-place vendor switch, force the Ops panes to respawn so
          // their baked `--vendor` flag (and the transcript store the activity
          // badge / turn detector poll) match the new engine (KOB-232).
          vendorChanged: versions.vendorChanged,
        }),
        versions,
      ),
    )
  }
  if (commands.length > 0) await runTmuxSequence(commands)
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
 */
export async function captureGlobalLayout(session: string): Promise<void> {
  // No `-s`: the active window's panes — the ones the user can see and drag.
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-t",
    `=${session}`,
    "-F",
    "#{@kobe_role}\t#{pane_width}\t#{pane_height}\t#{window_width}\t#{window_height}",
  ])
  if (code !== 0) return
  const rows = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => (cols[0]?.trim() ?? "") !== "")
  if (rows.length === 0) return
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
 * single owner of the tmux border re-style below — the two border options
 * are server-global, so this one call after a Settings exit covers every
 * session; applying them from each pane's live-prefs hook would just race
 * the same `set-option`s.
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
  if (commands.length > 0) await runTmuxSequence(commands)

  // The Appearance prefs the respawned panes just re-read also drive the
  // tmux border colors — re-derive those in the same pass so a theme
  // switch restyles the pane separators without a new session build.
  await applyTmuxPaneBorderTheme()
}
