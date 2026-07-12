/** @jsxImportSource @opentui/react */
/**
 * KanbanPage — the daemon-owned issue store as a Backlog / In progress /
 * Done board. One PROJECT at a time (tab/←/→ or click cycles the rolling
 * selector), three full-height bordered columns matching the workspace host's
 * border grammar. Full-page swap in the workspace host, same shape as
 * WorktreesPage (issue #23 precedent): esc/ctrl+c closes, `r` refetches,
 * plus a light poll so agent-driven moves (`kobe api issue-update --task`)
 * show up while the page is open.
 *
 * The BOARD stays read-only (agents move cards via `kobe api issue-*`); the
 * human surface on top of it is selection + the detail drawer: ←↓↑→ moves
 * the card cursor (highlighted border), Enter (or clicking the selected
 * card) opens {@link IssueDetailDialog}, whose Start action hands an
 * {@link IssueChatStart} up to the host (engine + workspace placement +
 * attachments). Column math is the framework-free `state/issue-board.ts` —
 * columns derive from the issue's own lifecycle (done > linked-task >
 * backlog), never from task status.
 */

import { TextAttributes } from "@opentui/core"
import type { Issue, RepoIssues } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { type ReactNode, useEffect, useState } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { availableEngineIds } from "../../engine/account-detect"
import { engineDisplayName } from "../../engine/interactive-command"
import { type BoardColumnKey, buildIssueBoard, moveBoardSelection } from "../../state/issue-board"
import { sidebarProjectLabel } from "../../tui/panes/sidebar/groups"
import type { VendorId } from "../../types/task"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { pageCloseBindings, useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { quickForkDefaultVendor } from "../workspace/quick-fork"
import type { IssueChatStart } from "../workspace/use-issue-chat"
import { IssueDetailDialog } from "./issue-detail-dialog"

/** Agent moves land within one poll; issue.list is a local JSON read, so
 *  polling while the page is open is cheap. */
const POLL_MS = 5_000

const COLUMN_LABEL_KEY: Record<BoardColumnKey, string> = {
  backlog: "kanban.column.backlog",
  in_progress: "kanban.column.inProgress",
  done: "kanban.column.done",
}

export function KanbanPage(props: {
  orchestrator: RemoteOrchestrator | null
  onClose: () => void
  /** Detail drawer's Start — the host owns task creation + prompt handoff. */
  onStartChat: (request: IssueChatStart) => Promise<void>
  /** Open a linked story's existing session (closes the kanban page). */
  onOpenTask: (taskId: string) => void
}): ReactNode {
  const { theme, transparentBackground } = useTheme()
  const columnBorder = transparentBackground ? theme.border : theme.borderSubtle
  const t = useT()
  const dialog = useDialog()

  const [boards, setBoards] = useState<readonly RepoIssues[] | null>(null)
  // Detected engines for the detail drawer's picker — one probe per page
  // open (account files on disk; cheap and refreshed enough).
  const [engines, setEngines] = useState<readonly VendorId[]>([])
  useEffect(() => {
    let disposed = false
    void availableEngineIds().then((ids) => {
      if (!disposed) setEngines(ids)
    })
    return () => {
      disposed = true
    }
  }, [])
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
  const columns = activeBoard ? buildIssueBoard(activeBoard.issues) : []

  // Card cursor — an issue id (not an index) so a poll refetch that reorders
  // a column keeps the selection on the same story.
  const [selectedId, setSelectedId] = useState<number | null>(null)

  function cycleProject(delta: number): void {
    if (boardList.length === 0) return
    const next = (activeIndex + delta + boardList.length) % boardList.length
    setActiveRepo(boardList[next]?.repoRoot ?? null)
    setSelectedId(null)
  }

  function moveCursor(dir: "up" | "down" | "left" | "right"): void {
    const next = moveBoardSelection(columns, selectedId, dir)
    if (next != null) setSelectedId(next)
  }

  // ←/→ MOVED from project-cycling to card selection when cards exist —
  // tab still cycles projects. On an empty board they fall through to
  // project cycling so the old muscle memory keeps working there.
  function moveOrCycle(dir: "left" | "right"): void {
    if (columns.some((column) => column.issues.length > 0)) moveCursor(dir)
    else cycleProject(dir === "left" ? -1 : 1)
  }

  /** Enter (or clicking the selected card): the story's detail drawer.
   *  EVERY outcome carries the drafted title/body — a dirty patch persists
   *  through `issue.mutate update` (best-effort: an edit must not block the
   *  start/open the user asked for), then the outcome routes to the host.
   *  undefined = discarded (ctrl+c / backdrop). */
  function openDetail(issue: Issue): void {
    const board = activeBoard
    if (!board) return
    setSelectedId(issue.id)
    void IssueDetailDialog.show(dialog, {
      issue,
      engines,
      defaultVendor: quickForkDefaultVendor(board.repoRoot, engines),
      engineLabel: engineDisplayName,
    }).then(async (outcome) => {
      if (!outcome) return
      const patch = { title: outcome.title, body: outcome.body }
      if (patch.title !== issue.title || patch.body !== issue.body) {
        await props.orchestrator
          ?.mutateIssue(board.repoRoot, { type: "update", id: issue.id, ...patch })
          .catch((err: unknown) => console.error("[kobe kanban] issue update failed:", err))
        setReloadTick((tick) => tick + 1)
      }
      if (outcome.kind === "open") {
        props.onOpenTask(outcome.taskId)
        return
      }
      // "close" saved above; "create" never comes from detail mode.
      if (outcome.kind !== "start") return
      void props.onStartChat({
        repoRoot: board.repoRoot,
        issue: { ...issue, ...patch },
        vendor: outcome.vendor,
        placement: outcome.placement,
      })
    })
  }

  function openSelectedDetail(): void {
    const issue = activeBoard?.issues.find((entry) => entry.id === selectedId)
    if (issue) openDetail(issue)
  }

  /** `n` — the new-story intake: the detail drawer in create mode. ctrl+s
   *  files the story; enter/ctrl+enter files it AND starts it immediately
   *  at the chosen engine/placement (the web intake's Execute button). */
  function openIntake(): void {
    const board = activeBoard
    if (!board) return
    const blank: Issue = {
      id: board.nextId,
      title: "",
      status: "open",
      created: new Date().toISOString().slice(0, 10),
      body: "",
    }
    void IssueDetailDialog.show(dialog, {
      issue: blank,
      mode: "create",
      engines,
      defaultVendor: quickForkDefaultVendor(board.repoRoot, engines),
      engineLabel: engineDisplayName,
    }).then(async (outcome) => {
      if (!outcome || outcome.kind !== "create") return
      const orch = props.orchestrator
      if (!orch) return
      try {
        const state = await orch.mutateIssue(board.repoRoot, {
          type: "create",
          title: outcome.title,
          body: outcome.body,
        })
        setReloadTick((tick) => tick + 1)
        if (!outcome.start) return
        // The daemon allocates the id from nextId; fall back to the newest
        // record if another writer raced the counter between open and save.
        const created =
          state.issues.find((entry) => entry.id === board.nextId) ??
          state.issues.reduce<Issue | null>((max, entry) => (max && max.id > entry.id ? max : entry), null)
        if (!created) return
        void props.onStartChat({
          repoRoot: board.repoRoot,
          issue: created,
          vendor: outcome.start.vendor,
          placement: outcome.start.placement,
        })
      } catch (err) {
        console.error("[kobe kanban] issue create failed:", err)
      }
    })
  }

  /** `d` — delete the selected story after a confirm. Deletes ONLY the
   *  issue record; a linked task/branch/worktree is left untouched. */
  function requestDelete(): void {
    const board = activeBoard
    const issue = board?.issues.find((entry) => entry.id === selectedId)
    if (!board || !issue) return
    void DialogConfirm.show(
      dialog,
      t("kanban.confirmDelete.title", { id: String(issue.id) }),
      t("kanban.confirmDelete.body", { title: issue.title }),
    ).then((confirmed) => {
      if (!confirmed) return
      void props.orchestrator
        ?.mutateIssue(board.repoRoot, { type: "delete", id: issue.id })
        .then(() => {
          setSelectedId(null)
          setReloadTick((tick) => tick + 1)
        })
        .catch((err: unknown) => console.error("[kobe kanban] issue delete failed:", err))
    })
  }

  useBindings(() => ({
    // Dormant while the detail drawer is up — the dialog owns the keyboard
    // (same gate as WorktreesPage).
    enabled: dialog.stack.length === 0,
    bindings: [
      ...pageCloseBindings(props.onClose),
      { key: "r", cmd: () => setReloadTick((tick) => tick + 1) },
      { key: "tab", cmd: () => cycleProject(1) },
      { key: "up", cmd: () => moveCursor("up") },
      { key: "down", cmd: () => moveCursor("down") },
      { key: "right", cmd: () => moveOrCycle("right") },
      { key: "left", cmd: () => moveOrCycle("left") },
      { key: "return", cmd: () => openSelectedDetail() },
      { key: "n", cmd: () => openIntake() },
      { key: "d", cmd: () => requestDelete() },
    ],
  }))

  const columnAccent = {
    backlog: theme.textMuted,
    in_progress: theme.accent,
    done: theme.success,
  } satisfies Record<BoardColumnKey, unknown>

  function card(issue: Issue, column: BoardColumnKey): ReactNode {
    const fg = column === "done" ? theme.textMuted : theme.text
    const description = issue.body.trim()
    const isSelected = issue.id === selectedId
    // backgroundElement survives transparent mode on purpose (see
    // applyDisplayOverlay): cards are content, not chrome — they keep a
    // tinted surface so the board reads against any host wallpaper.
    return (
      <box
        key={issue.id}
        border={true}
        borderColor={isSelected ? theme.primary : columnBorder}
        backgroundColor={theme.backgroundElement}
        paddingLeft={1}
        paddingRight={1}
        // First click selects; a click on the already-selected card opens
        // its detail drawer (Enter's mouse twin).
        onMouseUp={() => (isSelected ? openDetail(issue) : setSelectedId(issue.id))}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={fg} attributes={TextAttributes.BOLD} wrapMode="word" flexShrink={1}>
            {issue.title}
          </text>
          <text fg={theme.textMuted} wrapMode="none">
            #{issue.id}
          </text>
        </box>
        {/* Two-line preview is deliberate card grammar: enough room for a
            description now, with a stable region for the future editor. */}
        <box height={2} overflow="hidden">
          {description ? (
            <text fg={theme.textMuted} wrapMode="word">
              {description}
            </text>
          ) : null}
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted} wrapMode="none">
            {issue.created}
          </text>
          {column === "backlog" && issue.status === "hold" ? (
            <text fg={theme.warning} wrapMode="none">
              {t("kanban.hold")}
            </text>
          ) : null}
        </box>
      </box>
    )
  }

  /** One-line rolling project selector — tab/←/→ (or click) cycles, no tab
   *  row. Label stays flush with the page's left edge. */
  function projectSelector(active: RepoIssues): ReactNode {
    return (
      <box flexDirection="row" justifyContent="space-between" paddingTop={1} paddingLeft={3} paddingRight={3}>
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

  function board(): ReactNode {
    return (
      <box flexDirection="row" gap={1} flexGrow={1} paddingTop={1} paddingLeft={1} paddingRight={1}>
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
              gap={1}
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

  // One shared left baseline at x=3: the board is inset one cell (border at
  // x=1, +border cell +padding = text at x=3), and every header/selector row
  // gets paddingLeft=3 — Kanban / project / Backlog / cards all align, with
  // one cell of air between the borders and the screen edge.
  return (
    <box flexGrow={1} backgroundColor={theme.background} paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("kanban.title")}
        </text>
        <text fg={theme.textMuted}>{t("kanban.hint")}</text>
      </box>
      {loading ? (
        <text fg={theme.textMuted} paddingLeft={3}>
          {t("kanban.loading")}
        </text>
      ) : boardList.length === 0 || !activeBoard ? (
        <text fg={theme.textMuted} paddingLeft={3}>
          {t("kanban.noRepos")}
        </text>
      ) : (
        <>
          {projectSelector(activeBoard)}
          {board()}
        </>
      )}
    </box>
  )
}
