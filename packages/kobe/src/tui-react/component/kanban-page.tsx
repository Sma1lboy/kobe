/** @jsxImportSource @opentui/react */
/**
 * KanbanPage — the daemon-owned issue store as a Backlog / In progress /
 * Done board, one section per repo (repos derived from the task list, like
 * the web Board). Full-page swap in the workspace host, same shape as
 * WorktreesPage (issue #23 precedent): esc/ctrl+c closes, `r` refetches,
 * plus a light poll so agent-driven moves (`kobe api issue-update --task`)
 * show up while the page is open.
 *
 * READ-ONLY on purpose: agents are the writers (`kobe api issue-*`); the
 * TUI is the human's viewing surface. Column math is the framework-free
 * `state/issue-board.ts` — columns derive from the issue's own lifecycle
 * (done > linked-task > backlog), never from task status.
 */

import { TextAttributes } from "@opentui/core"
import type { Issue, RepoIssues } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { type ReactNode, useEffect, useState } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { type BoardColumnKey, buildIssueBoard } from "../../state/issue-board"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { pageCloseBindings, useBindings } from "../lib/keymap"

/** Agent moves land within one poll; issue.list is a local JSON read, so
 *  polling while the page is open is cheap. */
const POLL_MS = 5_000

const COLUMN_LABEL_KEY: Record<BoardColumnKey, string> = {
  backlog: "kanban.column.backlog",
  in_progress: "kanban.column.inProgress",
  done: "kanban.column.done",
}

export function KanbanPage(props: { orchestrator: RemoteOrchestrator | null; onClose: () => void }): ReactNode {
  const { theme } = useTheme()
  const t = useT()

  const [boards, setBoards] = useState<readonly RepoIssues[] | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is a TRIGGER (the effect body doesn't read it) — the WorktreesPage refetch guard.
  useEffect(() => {
    let disposed = false
    const orch = props.orchestrator
    if (!orch) {
      setBoards([])
      return
    }
    const repos = [...new Set(orch.listTasks().map((task) => task.repo))]
    void Promise.all(repos.map((repo) => orch.listIssues(repo).catch(() => null))).then((results) => {
      if (disposed) return
      // A repo whose issue file doesn't exist yet still gets a section —
      // `exists: false` just means an empty board, not an error.
      setBoards(results.filter((res): res is RepoIssues => res !== null))
    })
    const timer = setInterval(() => setReloadTick((tick) => tick + 1), POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [props.orchestrator, reloadTick])

  useBindings(() => ({
    enabled: true,
    bindings: [...pageCloseBindings(props.onClose), { key: "r", cmd: () => setReloadTick((tick) => tick + 1) }],
  }))

  const columnAccent = {
    backlog: theme.textMuted,
    in_progress: theme.accent,
    done: theme.success,
  } satisfies Record<BoardColumnKey, unknown>

  function card(issue: Issue, column: BoardColumnKey): ReactNode {
    const fg = column === "done" ? theme.textMuted : theme.text
    return (
      <box key={issue.id} flexDirection="row">
        <text fg={theme.textMuted} wrapMode="none">
          #{issue.id}{" "}
        </text>
        <text fg={fg} wrapMode="none" flexShrink={1}>
          {issue.title}
        </text>
        {column === "backlog" && issue.status === "hold" ? (
          <text fg={theme.warning} wrapMode="none">
            {" "}
            {t("kanban.hold")}
          </text>
        ) : null}
      </box>
    )
  }

  function repoBoard(board: RepoIssues): ReactNode {
    const columns = buildIssueBoard(board.issues)
    return (
      <box key={board.repoRoot} gap={0} paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="none">
          {board.repoRoot}
        </text>
        {board.issues.length === 0 ? (
          <text fg={theme.textMuted} wrapMode="none">
            {t("kanban.empty")}
          </text>
        ) : (
          <box flexDirection="row" gap={2}>
            {columns.map((col) => (
              <box key={col.key} flexGrow={1} flexBasis={0} gap={0}>
                <text fg={columnAccent[col.key]} attributes={TextAttributes.BOLD} wrapMode="none">
                  {t(COLUMN_LABEL_KEY[col.key])} ({col.issues.length + col.hiddenCount})
                </text>
                {col.issues.map((issue) => card(issue, col.key))}
                {col.hiddenCount > 0 ? (
                  <text fg={theme.textMuted} wrapMode="none">
                    {t("kanban.more", { count: String(col.hiddenCount) })}
                  </text>
                ) : null}
              </box>
            ))}
          </box>
        )}
      </box>
    )
  }

  const loading = boards === null

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
          {t("kanban.title")}
        </text>
        <text fg={theme.textMuted}>{t("kanban.hint")}</text>
      </box>
      {loading ? (
        <text fg={theme.textMuted}>{t("kanban.loading")}</text>
      ) : (boards ?? []).length === 0 ? (
        <text fg={theme.textMuted}>{t("kanban.noRepos")}</text>
      ) : (
        (boards ?? []).map(repoBoard)
      )}
    </scrollbox>
  )
}
