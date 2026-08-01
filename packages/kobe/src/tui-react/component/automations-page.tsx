/** @jsxImportSource @opentui/react */
/**
 * AutomationsPage — the daemon's scheduled automations as a full-page list.
 *
 * Same shape as {@link WorktreesPage}: a standalone full-window surface, the
 * shared close-key contract, `useState` + a `reloadTick`-keyed `useEffect`
 * whose stale completions are dropped by an effect-local `disposed` flag.
 *
 * Read-mostly by design. Creating an automation needs a repo, a prompt, a cron
 * expression, and optionally a precheck command — a form that belongs in a
 * composer, not a list row, so creation stays on `kobe api automation-create`.
 * What the page does own is the triage loop: see what is scheduled, see what
 * each run did, pause/resume, run one now, delete.
 */

import { TextAttributes } from "@opentui/core"
import type { Automation, AutomationRun } from "@sma1lboy/kobe-daemon/daemon/contracts"
import { type ReactNode, useEffect, useState } from "react"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import { clampCursor } from "../../tui/component/new-task-dialog/state"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { pageCloseBindings, useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { resolveRowSelectionChrome } from "../ui/row-selection-chrome"

/** Agent-driven edits land within a poll; `automation.list` is a local read. */
const POLL_MS = 5_000

/** Run-status → how it should read at a glance. The four "didn't run" reasons
 *  are deliberately distinct: `skipped_precheck` is healthy (nothing to do),
 *  `dispatch_failed` wants a human. Collapsing them would hide that. */
const RUN_TONE: Record<string, "success" | "muted" | "warning" | "error"> = {
  dispatched: "success",
  skipped_precheck: "muted",
  skipped_missed: "warning",
  skipped_unavailable: "warning",
  dispatch_failed: "error",
}

function formatWhen(iso: string | undefined, now: number): string {
  if (!iso) return "—"
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return "—"
  const deltaMs = at - now
  const abs = Math.abs(deltaMs)
  const mins = Math.round(abs / 60_000)
  if (mins < 1) return deltaMs >= 0 ? "now" : "just now"
  if (mins < 60) return deltaMs >= 0 ? `in ${mins}m` : `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return deltaMs >= 0 ? `in ${hours}h` : `${hours}h ago`
  return new Date(at).toLocaleDateString()
}

function repoLabel(repo: string): string {
  return repo.split("/").filter(Boolean).pop() ?? repo
}

export function AutomationsPage(props: {
  orchestrator: RemoteOrchestrator | null
  onClose: () => void
  onOpenTask?: (taskId: string) => void
}): ReactNode {
  const { theme } = useTheme()
  const dialog = useDialog()
  const t = useT()

  const [automations, setAutomations] = useState<readonly Automation[] | null>(null)
  const [keepsDaemonAlive, setKeepsDaemonAlive] = useState(false)
  const [runs, setRuns] = useState<readonly AutomationRun[]>([])
  const [reloadTick, setReloadTick] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const refetch = (): void => setReloadTick((tick) => tick + 1)

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is a TRIGGER (the body doesn't read it).
  useEffect(() => {
    let disposed = false
    const orch = props.orchestrator
    if (!orch) {
      setAutomations([])
      return
    }
    const load = (): void => {
      void orch
        .listAutomations()
        .then((result) => {
          if (disposed) return
          setAutomations(result.automations)
          setKeepsDaemonAlive(result.keepsDaemonAlive)
        })
        .catch(() => {
          // A failed read leaves the previous rows rather than crashing the page.
          if (!disposed) setAutomations((prev) => prev ?? [])
        })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [props.orchestrator, reloadTick])

  const rows = automations ?? []
  const [cursor, setCursor] = useState(0)
  useEffect(() => {
    setCursor((c) => clampCursor(c, rows.length))
  }, [rows.length])

  const selected = rows[cursor]

  // Run history follows the cursor: the list answers "what is scheduled", the
  // history answers "did it actually do anything", and the second question is
  // only ever asked about one automation at a time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is a TRIGGER (the body doesn't read it).
  useEffect(() => {
    let disposed = false
    const orch = props.orchestrator
    if (!orch || !selected) {
      setRuns([])
      return
    }
    void orch
      .automationRuns(selected.id)
      .then((result) => {
        if (!disposed) setRuns(result.runs)
      })
      .catch(() => {
        if (!disposed) setRuns([])
      })
    return () => {
      disposed = true
    }
  }, [props.orchestrator, selected, reloadTick])

  async function toggleEnabled(): Promise<void> {
    const orch = props.orchestrator
    if (!orch || !selected || busyId) return
    setBusyId(selected.id)
    try {
      await orch.setAutomationEnabled(selected.id, !selected.enabled)
      refetch()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function runNow(): Promise<void> {
    const orch = props.orchestrator
    if (!orch || !selected || busyId) return
    setBusyId(selected.id)
    setNotice(t("automations.running", { name: selected.name }))
    try {
      const result = await orch.runAutomationNow(selected.id)
      setNotice(t("automations.ranWith", { name: selected.name, status: result.status }))
      refetch()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  async function requestDelete(): Promise<void> {
    const orch = props.orchestrator
    if (!orch || !selected || busyId) return
    const ok = await DialogConfirm.show(
      dialog,
      t("automations.deleteTitle"),
      t("automations.deleteBody", { name: selected.name }),
      t("common.cancel"),
      t("automations.deleteButton"),
    )
    if (ok !== true) return
    setBusyId(selected.id)
    try {
      await orch.deleteAutomation(selected.id)
      refetch()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  useBindings(() => ({
    bindings: {
      ...pageCloseBindings(props.onClose),
      j: () => setCursor((c) => clampCursor(c + 1, rows.length)),
      down: () => setCursor((c) => clampCursor(c + 1, rows.length)),
      k: () => setCursor((c) => clampCursor(c - 1, rows.length)),
      up: () => setCursor((c) => clampCursor(c - 1, rows.length)),
      r: () => refetch(),
      e: () => void toggleEnabled(),
      s: () => void runNow(),
      d: () => void requestDelete(),
      return: () => {
        const taskId = runs.find((run) => run.taskId)?.taskId
        if (taskId) props.onOpenTask?.(taskId)
      },
    },
  }))

  const now = Date.now()

  return (
    <box flexDirection="column" flexGrow={1} padding={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.accent}>
          {t("automations.title")}
        </text>
        <text fg={theme.textMuted}>
          {keepsDaemonAlive ? t("automations.holdingDaemon") : t("automations.notHolding")}
        </text>
      </box>

      {automations === null ? (
        <text fg={theme.textMuted}>{t("common.loading")}</text>
      ) : rows.length === 0 ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.textMuted}>{t("automations.empty")}</text>
          <text fg={theme.textMuted}>{t("automations.emptyHint")}</text>
        </box>
      ) : (
        <box flexDirection="column" marginTop={1} flexGrow={1}>
          {rows.map((automation, index) => {
            // Same row grammar as the sidebar's task cards: a ▌ marker column,
            // a bold title line, and a muted detail line beneath it. Two lines
            // per row rather than one wide row — the schedule and next-run
            // time do not fit beside a name at any realistic pane width.
            const chrome = resolveRowSelectionChrome(theme, { cursor: index === cursor, selected: false })
            return (
              <box
                key={automation.id}
                flexDirection="column"
                flexShrink={0}
                {...(chrome.backgroundColor ? { backgroundColor: chrome.backgroundColor } : {})}
              >
                <box flexDirection="row" gap={0}>
                  <text fg={chrome.markerColor} wrapMode="none">
                    {chrome.marker}
                  </text>
                  <box flexDirection="row" flexGrow={1} paddingLeft={1} paddingRight={1} gap={1}>
                    <text
                      fg={automation.enabled ? theme.text : theme.textMuted}
                      attributes={index === cursor ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      flexGrow={1}
                    >
                      {automation.name}
                    </text>
                    {/* Paused reads as a state, not a missing feature. */}
                    {automation.enabled ? null : (
                      <text fg={theme.textMuted} wrapMode="none">
                        {t("automations.paused")}
                      </text>
                    )}
                  </box>
                </box>
                <box flexDirection="row" gap={0}>
                  <text fg={chrome.markerColor} wrapMode="none">
                    {chrome.marker}
                  </text>
                  <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
                    <text fg={theme.textMuted} wrapMode="none" flexGrow={1}>
                      {`${repoLabel(automation.repo)} · ${automation.schedule}`}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {formatWhen(automation.nextRunAt, now)}
                    </text>
                  </box>
                </box>
              </box>
            )
          })}
        </box>
      )}

      {selected ? (
        <box flexDirection="column" marginTop={1} border borderColor={theme.border} padding={1}>
          <text fg={theme.textMuted}>{selected.prompt}</text>
          {selected.precheck ? (
            <text fg={theme.textMuted}>{t("automations.precheck", { command: selected.precheck.command })}</text>
          ) : null}
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            {t("automations.recentRuns")}
          </text>
          {runs.length === 0 ? (
            <text fg={theme.textMuted}>{t("automations.noRuns")}</text>
          ) : (
            runs.slice(0, 5).map((run) => {
              const tone = RUN_TONE[run.status] ?? "muted"
              const color =
                tone === "success"
                  ? theme.success
                  : tone === "warning"
                    ? theme.warning
                    : tone === "error"
                      ? theme.error
                      : theme.textMuted
              return (
                <text key={run.id} fg={color}>
                  {`#${run.runNumber} ${run.status}${run.error ? ` — ${run.error}` : ""}  ${formatWhen(run.at, now)}`}
                </text>
              )
            })
          )}
        </box>
      ) : null}

      {notice ? <text fg={theme.textMuted}>{notice}</text> : null}
      <text fg={theme.textMuted}>{t("automations.keys")}</text>
    </box>
  )
}
