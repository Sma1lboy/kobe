/** @jsxImportSource @opentui/react */

import { type RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import type { AttentionInboxItem, RemoteOrchestrator, TaskEngineState } from "../../client/remote-orchestrator"
import { engineEntry } from "../../engine/registry"
import { DEFAULT_SPINNER_FRAMES } from "../../engine/spinner-frames"
import { relativeAgeMs } from "../../tui/history/message-core"
import { spinnerFrameSnapshot, subscribeSpinnerFrame } from "../../tui/lib/spinner-frame-store"
import { sidebarProjectLabel } from "../../tui/panes/sidebar/groups"
import { tabTitleStable } from "../../tui/workspace/terminal-tabs-core"
import type { Task } from "../../types/task"
import { DEFAULT_TASK_VENDOR } from "../../types/task"
import { bindByIds } from "../context/keybindings"
import { type KVContext, useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { useAccessor } from "../lib/use-accessor"
import { type DialogContext, useDialog } from "../ui/dialog"
import { resolveRowSelectionChrome } from "../ui/row-selection-chrome"
import {
  type InboxRow,
  clampSelectableRow,
  inboxRows,
  isAttentionInboxItemAvailable,
  nextSelectableRow,
  partitionAttentionInboxAvailability,
} from "./attention-inbox-core"
import { readInboxVisits } from "./inbox-visits"
import { activeTabIdFor, knownTaskTab } from "./terminal-tabs-shared"

const MAX_VISIBLE_CARDS = 6
const CARD_ROWS_WITH_GAP = 3
const DIALOG_CHROME_ROWS = 7
const AGE_REFRESH_MS = 30_000

function itemColor(state: AttentionInboxItem["state"], theme: ReturnType<typeof useTheme>["theme"]) {
  if (state === "permission_needed") return theme.warning
  if (state === "turn_complete") return theme.success
  return theme.error
}

function itemGlyph(state: AttentionInboxItem["state"]): string {
  if (state === "permission_needed") return "?"
  if (state === "turn_complete") return "✓"
  if (state === "rate_limited") return "⌛"
  return "!"
}

/** i18n key suffix for the state word shown next to the glyph. */
function itemStateKey(state: AttentionInboxItem["state"]): string {
  if (state === "permission_needed") return "workspace.inbox.state.needsInput"
  if (state === "turn_complete") return "workspace.inbox.state.done"
  if (state === "rate_limited") return "workspace.inbox.state.rateLimited"
  return "workspace.inbox.state.error"
}

/**
 * Engine-registry tab title for a (task, tab) pair — "" when unknown.
 *
 * `tabTitleStable`, NOT `tabTitle`: the Inbox renders tabs it does not host,
 * so raw `tabTitle` falls back to `lastTitle` — a FROZEN status line from
 * whenever a status-owning engine last reported ("✳ Claude Code", a stale
 * turn summary), which matches nothing the sidebar or tab strip shows. Same
 * rule (and rationale) as the sidebar tree's rows. A recorded tab that no
 * longer exists yields "" so the card falls back to task-level identity
 * instead of a raw `tab-N` id.
 */
function taskTabLabel(taskId: string, tabId: string | null, task: Task | undefined, kv: KVContext): string {
  const tab = tabId ? knownTaskTab(kv, taskId, tabId) : undefined
  return tab ? tabTitleStable(tab, task?.vendor ?? DEFAULT_TASK_VENDOR) : ""
}

function tabLabel(
  item: AttentionInboxItem,
  task: Task | undefined,
  kv: KVContext,
): { label: string; available: boolean } {
  const tab = item.tabId ? knownTaskTab(kv, item.taskId, item.tabId) : undefined
  return {
    label: taskTabLabel(item.taskId, item.tabId, task, kv),
    available: isAttentionInboxItemAvailable(item, task, () => tab !== undefined),
  }
}

/**
 * The only badge a RECENT row carries: is this task's engine still working?
 * Every OTHER activity state (done / error / needs input / rate limited)
 * already surfaced as an episode, so that task is sitting in ATTENTION
 * above — running is the one thing this section can tell you that the
 * queue can't. Frames are engine-owned (vendor registry).
 */
function runningBadge(opts: {
  activity: TaskEngineState | undefined
  task: Task
  frame: number
  theme: ReturnType<typeof useTheme>["theme"]
  t: ReturnType<typeof useT>
}): { glyph: string; label: string; color: RGBA } | undefined {
  if (opts.activity?.state !== "running") return undefined
  const frames = engineEntry(opts.task.vendor ?? DEFAULT_TASK_VENDOR).spinnerFrames ?? DEFAULT_SPINNER_FRAMES
  return {
    glyph: frames[opts.frame % frames.length] ?? frames[0] ?? "⠋",
    label: opts.t("workspace.inbox.state.running"),
    color: opts.theme.textMuted,
  }
}

const NOOP_SUBSCRIBE = () => () => {}
const ZERO_FRAME = () => 0

/** Shared 10Hz pulse, subscribed only while a row actually animates. */
function useSpinnerFrame(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribeSpinnerFrame : NOOP_SUBSCRIBE,
    active ? spinnerFrameSnapshot : ZERO_FRAME,
  )
}

/**
 * ONE card grammar for both sections: line 1 is WHERE (`project › tab` for
 * an episode, `project › task` for a recent task) plus its state badge and
 * age, line 2 is the context line. The attention badge is the only colored
 * ink — recent rows stay quiet so pending work still reads first.
 */
function InboxCard(props: {
  identity: string
  subtitle: string
  badge?: { glyph: string; label: string; color: RGBA }
  age: string
  active: boolean
  onOpen: () => void
}) {
  const { theme } = useTheme()
  // ONE cursor vocabulary across every navigable list: the shared sidebar
  // row chrome (▌ marker + row tint). Toast accent bars are a different
  // semantic (status color) and deliberately don't route through this.
  const selection = resolveRowSelectionChrome(theme, { cursor: props.active })
  return (
    <box
      flexDirection="row"
      paddingRight={2}
      backgroundColor={selection.backgroundColor}
      onMouseUp={(event: { stopPropagation(): void }) => {
        event.stopPropagation()
        props.onOpen()
      }}
    >
      {/* Selection bar — the sidebar's rail language, not a frame. */}
      <box flexDirection="column" flexShrink={0} paddingRight={1}>
        <text fg={selection.markerColor} wrapMode="none">
          {selection.marker}
        </text>
        <text fg={selection.markerColor} wrapMode="none">
          {selection.marker}
        </text>
      </box>
      <box flexDirection="column" flexBasis={0} flexGrow={1} flexShrink={1}>
        <box flexDirection="row">
          <text
            fg={theme.text}
            attributes={props.active ? TextAttributes.BOLD : undefined}
            wrapMode="none"
            flexBasis={0}
            flexGrow={1}
            flexShrink={1}
          >
            {props.identity}
          </text>
          {props.badge ? (
            <text fg={props.badge.color} wrapMode="none" flexShrink={0}>
              {` ${props.badge.glyph} ${props.badge.label}`}
            </text>
          ) : null}
          <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
            {`  ${props.age}`}
          </text>
        </box>
        <box flexDirection="row">
          <text fg={theme.textMuted} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
            {props.subtitle}
          </text>
        </box>
      </box>
    </box>
  )
}

export function AttentionInboxPane(props: {
  items: readonly AttentionInboxItem[]
  tasks: readonly Task[]
  kv: KVContext
  selectedId?: string | null
  engineStates?: ReadonlyMap<string, TaskEngineState>
  onOpen: (item: AttentionInboxItem, available: boolean) => void
  onOpenTask: (taskId: string, tabId: string | null) => void
  onDelete: (item: AttentionInboxItem) => void
  onClose: () => void
}) {
  const { theme } = useTheme()
  const t = useT()
  const dimensions = useTerminalDimensions()
  const [cursor, setCursor] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const { availableItems } = useMemo(
    () =>
      partitionAttentionInboxAvailability(
        props.items,
        props.tasks,
        (taskId, tabId) => knownTaskTab(props.kv, taskId, tabId) !== undefined,
      ),
    [props.items, props.tasks, props.kv],
  )
  // Every episode in the Inbox is pending by definition (opening one removes
  // it — no read/unread lifecycle), so the attention section IS the unread
  // set and always leads; recent tasks trail it. Unavailable targets are
  // hidden synchronously; the always-mounted Workspace host dismisses them
  // in the background so stale rows never flash onscreen.
  // RECENT is ordered by the visit log, not `updatedAt` — see inbox-visits.
  // Parsing yields a fresh array, and the KV context identity only changes
  // on a real write — memoizing on it keeps `rows` stable across the 10Hz
  // spinner tick.
  const visits = useMemo(() => readInboxVisits(props.kv), [props.kv])
  // Only the tab you're actually on is dropped, not its whole task — its
  // sibling chat tabs are exactly what RECENT is for.
  const selectedTabId = props.selectedId ? activeTabIdFor(props.selectedId) : null
  const rows = useMemo(
    () => inboxRows(availableItems, props.tasks, { selectedId: props.selectedId, selectedTabId, visits }),
    [availableItems, props.tasks, props.selectedId, selectedTabId, visits],
  )
  const attentionCount = rows.filter((row) => row.kind === "attention").length
  const anyRunning = rows.some(
    (row) => row.kind === "recent" && props.engineStates?.get(row.task.id)?.state === "running",
  )
  const spinnerFrame = useSpinnerFrame(anyRunning)
  // ponytail: headers are one line, cards three — the window budgets every
  // row as a card. Conservative by a couple of rows, never overflows.
  const maxVisibleCards = Math.max(
    1,
    Math.min(MAX_VISIBLE_CARDS, Math.floor((dimensions.height - DIALOG_CHROME_ROWS) / CARD_ROWS_WITH_GAP)),
  )
  const safeCursor = clampSelectableRow(rows, cursor)
  const windowStart = Math.max(0, Math.min(safeCursor - maxVisibleCards + 1, rows.length - maxVisibleCards))
  const visible = rows.slice(windowStart, windowStart + maxVisibleCards)
  const repos = [...new Set(props.tasks.map((task) => task.repo))]

  useEffect(() => {
    if (cursor !== safeCursor) setCursor(safeCursor)
  }, [cursor, safeCursor])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  function move(delta: 1 | -1): void {
    if (rows.length === 0) return
    setCursor(nextSelectableRow(rows, safeCursor, delta))
  }

  function selected(): InboxRow | undefined {
    return rows[safeCursor]
  }

  function open(row: InboxRow): void {
    if (row.kind === "recent") {
      props.onOpenTask(row.task.id, row.tabId)
      return
    }
    if (row.kind !== "attention") return
    const task = props.tasks.find((candidate) => candidate.id === row.item.taskId)
    props.onOpen(row.item, tabLabel(row.item, task, props.kv).available)
  }

  useBindings(() => ({
    bindings: bindByIds({
      "inbox.nav": (_event, slot) => move((slot ?? 0) % 2 === 0 ? 1 : -1),
      "inbox.open": () => {
        const row = selected()
        if (row) open(row)
      },
      // Only episodes are dismissible — a recent task has nothing to drop.
      "inbox.delete": () => {
        const row = selected()
        if (row?.kind === "attention") props.onDelete(row.item)
      },
    }),
  }))

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0} justifyContent="space-between">
        <box flexDirection="row">
          <text fg={theme.focusAccent} attributes={TextAttributes.BOLD} wrapMode="none">
            {t("workspace.inbox.title")}
          </text>
          <text fg={theme.textMuted} wrapMode="none">{` ${attentionCount}`}</text>
        </box>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={props.onClose}>
          esc
        </text>
      </box>
      {rows.length === 0 ? (
        <box paddingTop={1} paddingBottom={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {t("workspace.inbox.empty")}
          </text>
        </box>
      ) : (
        <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
          {visible.map((row, index) => {
            const absoluteIndex = windowStart + index
            if (row.kind === "header") {
              return (
                <text key={row.id} fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
                  {t(`workspace.inbox.section.${row.section}`)}
                </text>
              )
            }
            const active = absoluteIndex === safeCursor
            const openRow = () => {
              setCursor(absoluteIndex)
              open(row)
            }
            if (row.kind === "recent") {
              const project = sidebarProjectLabel(row.task.repo, repos)
              // A `main` task IS its repo — the sidebar shows the basename
              // instead of the stored title, so the Inbox matches.
              const title = row.task.kind === "main" ? project : row.task.title
              const tab = taskTabLabel(row.task.id, row.tabId, row.task, props.kv)
              // Same identity grammar as an episode row: `project › tab`
              // once we know which tab you were last on, task title below.
              return (
                <InboxCard
                  key={row.id}
                  identity={tab ? `${project} › ${tab}` : title === project ? project : `${project} › ${title}`}
                  subtitle={title}
                  badge={runningBadge({
                    activity: props.engineStates?.get(row.task.id),
                    task: row.task,
                    frame: spinnerFrame,
                    theme,
                    t,
                  })}
                  age={relativeAgeMs(row.at, now)}
                  active={active}
                  onOpen={openRow}
                />
              )
            }
            const item = row.item
            const task = props.tasks.find((candidate) => candidate.id === item.taskId)
            const tab = tabLabel(item, task, props.kv)
            const title = task?.title ?? item.taskId
            const project = task ? sidebarProjectLabel(task.repo, repos) : ""
            // Identity line: `project › tab` — WHERE the episode happened is
            // the primary key a user scans for (which project, which tab),
            // so it leads; the task title is context on line 2. Both labels
            // are runtime data (repo basename, engine-registry tab title) —
            // no vendor strings live here.
            return (
              <InboxCard
                key={row.id}
                identity={tab.label ? `${project} › ${tab.label}` : project || title}
                subtitle={title}
                badge={{
                  glyph: itemGlyph(item.state),
                  label: t(itemStateKey(item.state)),
                  color: itemColor(item.state, theme),
                }}
                age={relativeAgeMs(item.at, now)}
                active={active}
                onOpen={openRow}
              />
            )
          })}
        </box>
      )}
      <box flexDirection="row" flexShrink={0} gap={2} paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="none">
          {t("workspace.inbox.openHint")}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {t("workspace.inbox.deleteHint")}
        </text>
      </box>
    </box>
  )
}

export type AttentionInboxDialogProps = {
  orchestrator: RemoteOrchestrator
  selectedId?: string | null
  onOpen: (item: AttentionInboxItem, available: boolean) => void
  onOpenTask: (taskId: string, tabId: string | null) => void
  onDelete: (item: AttentionInboxItem) => void
}

export function AttentionInboxDialog(props: AttentionInboxDialogProps) {
  const dialog = useDialog()
  const kv = useKV()
  const items = useAccessor(props.orchestrator.attentionInboxSignal())
  const tasks = useAccessor(props.orchestrator.tasksSignal())
  const engineStates = useAccessor(props.orchestrator.engineStateSignal())
  return (
    <AttentionInboxPane
      items={items}
      tasks={tasks}
      kv={kv}
      selectedId={props.selectedId}
      engineStates={engineStates}
      onOpen={props.onOpen}
      onOpenTask={props.onOpenTask}
      onDelete={props.onDelete}
      onClose={() => dialog.clear()}
    />
  )
}

AttentionInboxDialog.show = (dialog: DialogContext, props: AttentionInboxDialogProps): void => {
  dialog.replace(() => <AttentionInboxDialog {...props} />)
  dialog.setSize("medium")
  dialog.setPlacement("upper-fifth")
}
