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
 *   - {@link healKobePaneVersions} — stale-version Tasks/Ops respawns,
 *     applied by `ensureSession` on every reuse/respawn outcome.
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
import { localSpawnCwd } from "@/exec/resolve"
import { getSessionOptions, runTmux, runTmuxCapturing, runTmuxSequence } from "@/tmux/client"
import { TASKS_PANE_WIDTH, keepAlive, opsPaneCommand, shellQuoteArgv, tasksPaneCommand } from "@/tmux/session-layout"
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
}

/** The one `list-panes -F` format every heal surface reads. */
const KOBE_PANE_LIST_FORMAT = `#{window_id}\t#{pane_id}\t#{@kobe_role}\t#{${PANE_VERSION_OPTION}}`

/** Parse `list-panes -F KOBE_PANE_LIST_FORMAT` output. Pure. */
export function parseKobePaneRows(stdout: string): KobePaneRow[] {
  const rows: KobePaneRow[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const [windowId, paneId, role, version] = line.split("\t")
    if (!windowId || !paneId || !role) continue
    rows.push({ windowId: windowId.trim(), paneId: paneId.trim(), role: role.trim(), version: version?.trim() ?? "" })
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
 */
export function planPaneHeals(
  rows: readonly KobePaneRow[],
  opts: { readonly currentVersion: string; readonly force: boolean },
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
    if (opsPane && (opts.force ? true : claudePane && opsPane.version !== opts.currentVersion)) {
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
 */
export async function relaunchEngineInAllWindows(
  session: string,
  cwd: string,
  command: readonly string[],
  remoteKey?: string,
): Promise<boolean> {
  const rows = await listKobePanes(session)
  if (!rows) return false
  const enginePanes = paneIdsByRole(rows, "claude")
  if (enginePanes.length === 0) return false
  const cmd = keepAlive(wrapEngineLaunch(shellQuoteArgv(command), remoteKey, cwd))
  for (const pane of enginePanes) {
    // `-k` kills the old engine process; `-c` is the LOCAL spawn dir (the
    // worktree is remote for a remote task — the wrapped ssh carries `cd <wt>`).
    await runTmux(["respawn-pane", "-k", "-c", localSpawnCwd(cwd), "-t", pane, cmd])
  }
  return true
}

/** Heal existing sessions built before the direct-tmux Tasks pane widened. */
export async function healTaskPaneWidths(session: string): Promise<void> {
  const rows = await listKobePanes(session)
  if (!rows) return
  const taskPanes = paneIdsByRole(rows, "tasks")
  await runTmuxSequence(taskPanes.map((pane) => ["resize-pane", "-t", pane, "-x", `${TASKS_PANE_WIDTH}`]))
}

/**
 * Heal only kobe-owned panes whose version tag is absent or stale:
 * respawn Tasks/Ops in place so newly shipped shortcuts and file-pane
 * behaviour don't appear "missing" until the user manually resets tmux.
 * Applied by `ensureSession` on every reuse/respawn outcome.
 */
export async function healKobePaneVersions(
  session: string,
  cwd: string,
  taskId: string | undefined,
  vendor: string | undefined,
): Promise<void> {
  const rows = await listKobePanes(session)
  if (!rows) return
  const commands = respawnCommandsFor(planPaneHeals(rows, { currentVersion: CURRENT_VERSION, force: false }), {
    cwd,
    taskId,
    vendor,
  })
  if (commands.length > 0) await runTmuxSequence(commands)
}

/**
 * Settings changes like transparent background are read by each kobe-owned
 * pane process at startup. After the full-window Settings page exits, the
 * existing Tasks/Ops panes in sibling ChatTabs are still alive, so respawn
 * only those helper panes in place to make the new UI prefs visible without
 * touching the user's engine or shell panes.
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
