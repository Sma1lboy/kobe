/** @jsxImportSource @opentui/react */
/**
 * WorktreesPage — React port of `src/tui/component/worktrees-page.tsx`
 * (issue #15/#23). Lists every git worktree across all locally-saved
 * projects (kobe-managed or not — see `worktree.list`'s handler), each row
 * flagging whether kobe manages it, its age, uncommitted-changes state, and
 * whether its branch has reached `origin`. Modeled on `tui-react/settings/
 * host.tsx` (standalone full-window surface, same close-key contract) and
 * the React new-task dialog's Adopt tab (cursor-navigable worktree list —
 * see `component/new-task-dialog/tab-adopt.tsx` for the row-grammar this
 * extends with badges).
 *
 * Delete flow mirrors the daemon's own safety gate
 * (`GitWorktreeManager.remove`): a clean worktree deletes on a single
 * confirm; a dirty one fails the first attempt and surfaces a SECOND,
 * more severe confirm before retrying with `force: true` — no client-side
 * dirty check duplicates the backend's.
 *
 * Solid→React deltas: the Solid `createResource` becomes THE ASYNC CANON
 * (`src/tui-react/history/host.tsx`) — `useState` + a `reloadTick`-keyed
 * `useEffect` whose stale completions are dropped by an effect-local
 * `disposed` flag; `refetch()` is just bumping `reloadTick`. `For`/`Show`
 * become plain `.map()`/ternaries.
 */

import { TextAttributes } from "@opentui/core"
import { type ReactNode, useEffect, useState } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { clampCursor } from "../../tui/component/new-task-dialog/state"
import { relativeAgeMs } from "../../tui/history/message-core"
import type { WorktreeAuditRow, WorktreeProject } from "../../types/worktree"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { pageCloseBindings, useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

function flattenRows(projects: readonly WorktreeProject[]): readonly WorktreeAuditRow[] {
  return projects.flatMap((p) => p.worktrees)
}

const DIRTY_REFUSAL_RE = /refusing to remove dirty worktree/
const LAND_CONFLICT_RE = /LAND_CONFLICT/
const MAIN_DIRTY_RE = /MAIN_CHECKOUT_DIRTY/

/** Match a worktree row's path to a tracked task id (loose realpath tolerance). */
function taskIdForPath(orch: RemoteOrchestrator, wtPath: string): string | undefined {
  const norm = (p: string): string => p.replace(/^\/private\//, "/").replace(/\/+$/, "")
  const target = norm(wtPath)
  return orch.listTasks().find((task) => task.worktreePath && norm(task.worktreePath) === target)?.id
}

export function WorktreesPage(props: { orchestrator: RemoteOrchestrator | null; onClose: () => void }): ReactNode {
  const { theme } = useTheme()
  const dialog = useDialog()
  const t = useT()

  const [projects, setProjects] = useState<readonly WorktreeProject[] | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const refetch = (): void => setReloadTick((tick) => tick + 1)

  // Two-phase load: the local-signals pass paints instantly, the full pass
  // (ls-remote + gh PR states, seconds when a remote is slow) swaps in when
  // it lands. `fullLanded` guards the rare inversion where the full pass
  // returns before the fast one — richer rows must not be overwritten.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is a TRIGGER (the effect body doesn't read it) — matching the Solid refetch() re-run guard.
  useEffect(() => {
    let disposed = false
    let fullLanded = false
    const orch = props.orchestrator
    if (!orch) {
      setProjects([])
      return
    }
    void orch
      .listWorktrees({ network: false })
      .then((rows) => {
        if (!disposed && !fullLanded) setProjects(rows)
      })
      .catch(() => {
        /* fast pass is best-effort; the full pass below still runs */
      })
    void orch
      .listWorktrees()
      .then((rows) => {
        fullLanded = true
        if (!disposed) setProjects(rows)
      })
      .catch(() => {
        // Same boundary as the Solid resource: a failed read leaves the
        // fast-pass rows (or the loading placeholder) rather than crashing.
      })
    return () => {
      disposed = true
    }
  }, [props.orchestrator, reloadTick])

  const flatRows = flattenRows(projects ?? [])

  const [cursor, setCursor] = useState(0)
  // Re-clamp whenever the row count changes — the Solid `createEffect` on `flatRows().length`.
  useEffect(() => {
    setCursor((c) => clampCursor(c, flatRows.length))
  }, [flatRows.length])

  const [busyPath, setBusyPath] = useState<string | null>(null)

  async function requestDelete(row: WorktreeAuditRow): Promise<void> {
    if (!props.orchestrator || busyPath) return
    const ok = await DialogConfirm.show(
      dialog,
      t("worktrees.delete.confirmTitle"),
      t("worktrees.delete.confirmBody", { branch: row.branch || row.path }),
      t("common.cancel"),
      t("worktrees.delete.button"),
    )
    if (ok !== true) return
    setBusyPath(row.path)
    try {
      await props.orchestrator.removeWorktree(row.path, false)
      refetch()
    } catch (err) {
      if (err instanceof Error && DIRTY_REFUSAL_RE.test(err.message)) {
        setBusyPath(null)
        const force = await DialogConfirm.show(
          dialog,
          t("worktrees.delete.forceTitle"),
          t("worktrees.delete.forceBody", { branch: row.branch || row.path }),
          t("common.cancel"),
          t("worktrees.delete.button"),
        )
        if (force === true) {
          setBusyPath(row.path)
          try {
            await props.orchestrator.removeWorktree(row.path, true)
            refetch()
          } catch (err2) {
            console.error(`[kobe worktrees] ${t("worktrees.delete.failed", { error: String(err2) })}`)
          }
        }
      } else {
        console.error(`[kobe worktrees] ${t("worktrees.delete.failed", { error: String(err) })}`)
      }
    } finally {
      setBusyPath(null)
    }
  }

  async function requestLand(row: WorktreeAuditRow): Promise<void> {
    const orch = props.orchestrator
    if (!orch || busyPath) return
    const taskId = taskIdForPath(orch, row.path)
    if (!taskId) {
      console.error(`[kobe worktrees] ${t("worktrees.land.noTask")}`)
      return
    }
    const ok = await DialogConfirm.show(
      dialog,
      t("worktrees.land.confirmTitle"),
      t("worktrees.land.confirmBody", { branch: row.branch || row.path }),
      t("common.cancel"),
      t("worktrees.land.button"),
    )
    if (ok !== true) return
    setBusyPath(row.path)
    try {
      const res = await orch.landTask(taskId)
      console.error(
        `[kobe worktrees] ${t("worktrees.land.done", { branch: res.branch, landedOn: res.landedOn, commit: res.commit })}`,
      )
      refetch()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (LAND_CONFLICT_RE.test(msg)) {
        console.error(`[kobe worktrees] ${t("worktrees.land.conflict", { files: msg })}`)
      } else if (MAIN_DIRTY_RE.test(msg)) {
        console.error(`[kobe worktrees] ${t("worktrees.land.dirtyBase")}`)
      } else {
        console.error(`[kobe worktrees] ${t("worktrees.land.failed", { error: msg })}`)
      }
    } finally {
      setBusyPath(null)
    }
  }

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      ...pageCloseBindings(props.onClose),
      { key: "up", cmd: () => setCursor((c) => clampCursor(c - 1, flatRows.length)) },
      { key: "down", cmd: () => setCursor((c) => clampCursor(c + 1, flatRows.length)) },
      {
        key: "d",
        cmd: () => {
          const row = flatRows[cursor]
          if (row) void requestDelete(row)
        },
      },
      {
        key: "l",
        cmd: () => {
          const row = flatRows[cursor]
          if (row) void requestLand(row)
        },
      },
    ],
  }))

  function remoteBadge(status: boolean | null): ReactNode {
    if (status === true) return <text fg={theme.success}> {t("worktrees.badge.remoteOn")}</text>
    if (status === false) return <text fg={theme.warning}> {t("worktrees.badge.remoteOff")}</text>
    return <text fg={theme.textMuted}> {t("worktrees.badge.remoteUnknown")}</text>
  }

  /** Staleness-rubric badge (see `orchestrator/worktree/staleness.ts`).
   *  `dirty` already has its own badge and `fresh` is the quiet default —
   *  neither repeats here. */
  function verdictBadge(row: WorktreeAuditRow): ReactNode {
    if (row.verdictReason === "dirty" || row.verdictReason === "fresh") return null
    const fg = row.verdict === "merged" ? theme.success : row.verdict === "stale" ? theme.warning : theme.accent
    return <text fg={fg}> {t(`worktrees.verdict.${row.verdictReason}`)}</text>
  }

  const loading = projects === null
  let rowBase = 0

  return (
    <scrollbox
      flexGrow={1}
      backgroundColor={theme.background}
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("worktrees.title")}
        </text>
        <text fg={theme.textMuted}>{t("worktrees.hint.legend")}</text>
      </box>

      {loading ? (
        <text fg={theme.textMuted}>{t("worktrees.loading")}</text>
      ) : (projects ?? []).length === 0 ? (
        <text fg={theme.textMuted}>{t("worktrees.noProjects")}</text>
      ) : (
        (projects ?? []).map((project) => {
          const base = rowBase
          rowBase += project.worktrees.length
          return (
            <box key={project.repo} gap={0} paddingTop={1}>
              <text fg={theme.textMuted} wrapMode="none">
                {project.repo}
              </text>
              {project.worktrees.length === 0 ? (
                <text fg={theme.textMuted} wrapMode="none">
                  {t("worktrees.noWorktrees")}
                </text>
              ) : (
                project.worktrees.map((row, i) => {
                  const absoluteIndex = base + i
                  const isCursor = absoluteIndex === cursor
                  return (
                    <box key={row.path} gap={0} onMouseUp={() => setCursor(absoluteIndex)}>
                      <box flexDirection="row">
                        <text
                          fg={isCursor ? theme.primary : theme.text}
                          attributes={isCursor ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                        >
                          {isCursor ? "▸ " : "  "}
                          {row.branch || t("worktrees.row.detached")}
                        </text>
                        {row.kobeManaged ? <text fg={theme.textMuted}> {t("worktrees.badge.kobeManaged")}</text> : null}
                        {row.dirty ? <text fg={theme.warning}> {t("worktrees.badge.dirty")}</text> : null}
                        {remoteBadge(row.branchOnRemote)}
                        {verdictBadge(row)}
                        {busyPath === row.path ? <text fg={theme.textMuted}> …</text> : null}
                      </box>
                      <box flexDirection="row" justifyContent="space-between" paddingLeft={2}>
                        <text fg={theme.textMuted} wrapMode="none">
                          {row.path}
                        </text>
                        {row.createdAtMs > 0 ? (
                          <text fg={theme.textMuted} wrapMode="none">
                            {t("worktrees.row.created", { age: relativeAgeMs(row.createdAtMs) })}
                          </text>
                        ) : null}
                      </box>
                    </box>
                  )
                })
              )}
            </box>
          )
        })
      )}
    </scrollbox>
  )
}
