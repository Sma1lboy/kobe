/** @jsxImportSource @opentui/react */
/**
 * KanbanPage — the daemon-owned issue store as a Backlog / In progress /
 * Done board. One PROJECT at a time (tab/←/→ or click cycles the repo
 * tabs), three full-height bordered columns matching the workspace host's
 * border grammar. Full-page swap in the workspace host, same shape as
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
import { sidebarProjectLabel } from "../../tui/panes/sidebar/groups"
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
  const { theme, transparentBackground } = useTheme()
  const columnBorder = transparentBackground ? theme.border : theme.borderSubtle
  const t = useT()

  const [boards, setBoards] = useState<readonly RepoIssues[] | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  // Keyed by repoRoot (not index) so the poll refetch keeps the selection.
  const [activeRepo, setActiveRepo] = useState<string | null>(null)

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
      const next = results.filter((res): res is RepoIssues => res !== null)
      next.sort((a, b) => a.repoRoot.localeCompare(b.repoRoot))
      setBoards(next)
      // First load lands on the project you opened kobe in — the active
      // task's repo (loose realpath tolerance, like WorktreesPage).
      const norm = (p: string): string => p.replace(/^\/private\//, "/").replace(/\/+$/, "")
      const activeId = orch.activeTaskSignal().get()
      const currentRepo = orch.listTasks().find((task) => task.id === activeId)?.repo
      const initial = currentRepo
        ? (next.find((board) => norm(board.repoRoot) === norm(currentRepo))?.repoRoot ?? null)
        : null
      setActiveRepo((prev) => prev ?? initial)
    })
    const timer = setInterval(() => setReloadTick((tick) => tick + 1), POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [props.orchestrator, reloadTick])

  const boardList = boards ?? []
  const activeIndex = Math.max(
    0,
    boardList.findIndex((board) => board.repoRoot === activeRepo),
  )
  const activeBoard: RepoIssues | undefined = boardList[activeIndex]
  const repoRoots = boardList.map((board) => board.repoRoot)

  function cycleProject(delta: number): void {
    if (boardList.length === 0) return
    const next = (activeIndex + delta + boardList.length) % boardList.length
    setActiveRepo(boardList[next]?.repoRoot ?? null)
  }

  useBindings(() => ({
    enabled: true,
    bindings: [
      ...pageCloseBindings(props.onClose),
      { key: "r", cmd: () => setReloadTick((tick) => tick + 1) },
      { key: "tab", cmd: () => cycleProject(1) },
      { key: "right", cmd: () => cycleProject(1) },
      { key: "left", cmd: () => cycleProject(-1) },
    ],
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

  /** One-line rolling project selector — tab/←/→ (or click) cycles, no tab
   *  row. Label stays flush with the page's left edge. */
  function projectSelector(active: RepoIssues): ReactNode {
    return (
      <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingLeft={2} paddingRight={2}>
        <box flexDirection="row" onMouseUp={() => cycleProject(1)}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
            {sidebarProjectLabel(active.repoRoot, repoRoots)}
          </text>
          {boardList.length > 1 ? (
            <text fg={theme.textMuted} wrapMode="none">
              {" "}
              {activeIndex + 1}/{boardList.length}
            </text>
          ) : null}
          <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
            {"  "}
            {active.repoRoot}
          </text>
        </box>
        {active.issues.length === 0 ? (
          <text fg={theme.textMuted} wrapMode="none">
            {t("kanban.empty")}
          </text>
        ) : null}
      </box>
    )
  }

  function board(active: RepoIssues): ReactNode {
    const columns = buildIssueBoard(active.issues)
    return (
      <box flexDirection="row" gap={1} flexGrow={1} paddingTop={1}>
        {columns.map((col) => (
          <box
            key={col.key}
            flexGrow={1}
            flexBasis={0}
            border={true}
            borderColor={columnBorder}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={columnAccent[col.key]} attributes={TextAttributes.BOLD} wrapMode="none">
              {t(COLUMN_LABEL_KEY[col.key])} ({col.issues.length + col.hiddenCount})
            </text>
            <scrollbox
              flexGrow={1}
              paddingTop={1}
              verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
            >
              {col.issues.map((issue) => card(issue, col.key))}
              {col.hiddenCount > 0 ? (
                <text fg={theme.textMuted} wrapMode="none">
                  {t("kanban.more", { count: String(col.hiddenCount) })}
                </text>
              ) : null}
            </scrollbox>
          </box>
        ))}
      </box>
    )
  }

  const loading = boards === null

  // One shared left baseline: header/selector rows get paddingLeft=2, the
  // column boxes run flush to the edge so border(1)+padding(1) lands their
  // text on the SAME x=2 — Kanban / project / Backlog / cards all align.
  return (
    <box flexGrow={1} backgroundColor={theme.background} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("kanban.title")}
        </text>
        <text fg={theme.textMuted}>{t("kanban.hint")}</text>
      </box>
      {loading ? (
        <text fg={theme.textMuted} paddingLeft={2}>
          {t("kanban.loading")}
        </text>
      ) : boardList.length === 0 || !activeBoard ? (
        <text fg={theme.textMuted} paddingLeft={2}>
          {t("kanban.noRepos")}
        </text>
      ) : (
        <>
          {projectSelector(activeBoard)}
          {board(activeBoard)}
        </>
      )}
    </box>
  )
}
