import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator"
import type { WorktreeAuditRow } from "../../types/worktree"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

function relativeAge(ms: number): string {
  if (!ms) return ""
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function clampCursor(next: number, len: number): number {
  if (len <= 0) return 0
  return Math.min(Math.max(next, 0), len - 1)
}

const DIRTY_REFUSAL_RE = /refusing to remove dirty worktree/

export function WorktreesPage(props: { orchestrator: RemoteOrchestrator | null; onClose: () => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [projects, { refetch }] = createResource(async () => {
    if (!props.orchestrator) return []
    return props.orchestrator.listWorktrees()
  })

  const flatRows = createMemo<readonly WorktreeAuditRow[]>(() => (projects() ?? []).flatMap((p) => p.worktrees))

  const [cursor, setCursor] = createSignal(0)
  createEffect(() => {
    void flatRows()
    setCursor((c) => clampCursor(c, flatRows().length))
  })

  const [busyPath, setBusyPath] = createSignal<string | null>(null)

  async function requestDelete(row: WorktreeAuditRow): Promise<void> {
    if (!props.orchestrator || busyPath()) return
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

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "escape", cmd: props.onClose },
      { key: "q", cmd: props.onClose },
      { key: "ctrl+c", cmd: props.onClose },
      { key: "up", cmd: () => setCursor((c) => clampCursor(c - 1, flatRows().length)) },
      { key: "down", cmd: () => setCursor((c) => clampCursor(c + 1, flatRows().length)) },
      {
        key: "d",
        cmd: () => {
          const row = flatRows()[cursor()]
          if (row) void requestDelete(row)
        },
      },
    ],
  }))

  function remoteBadge(status: boolean | null) {
    if (status === true) return <text fg={theme.success}> {t("worktrees.badge.remoteOn")}</text>
    if (status === false) return <text fg={theme.warning}> {t("worktrees.badge.remoteOff")}</text>
    return <text fg={theme.textMuted}> {t("worktrees.badge.remoteUnknown")}</text>
  }

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

      <Show when={!projects.loading} fallback={<text fg={theme.textMuted}>{t("worktrees.loading")}</text>}>
        <Show
          when={(projects() ?? []).length > 0}
          fallback={<text fg={theme.textMuted}>{t("worktrees.noProjects")}</text>}
        >
          <For each={projects() ?? []}>
            {(project) => {
              let base = 0
              for (const p of projects() ?? []) {
                if (p.repo === project.repo) break
                base += p.worktrees.length
              }
              return (
                <box gap={0} paddingTop={1}>
                  <text fg={theme.textMuted} wrapMode="none">
                    {project.repo}
                  </text>
                  <Show
                    when={project.worktrees.length > 0}
                    fallback={
                      <text fg={theme.textMuted} wrapMode="none">
                        {t("worktrees.noWorktrees")}
                      </text>
                    }
                  >
                    <For each={project.worktrees}>
                      {(row, i) => {
                        const absoluteIndex = () => base + i()
                        const isCursor = () => absoluteIndex() === cursor()
                        return (
                          <box gap={0} onMouseUp={() => setCursor(absoluteIndex())}>
                            <box flexDirection="row">
                              <text
                                fg={isCursor() ? theme.primary : theme.text}
                                attributes={isCursor() ? TextAttributes.BOLD : undefined}
                                wrapMode="none"
                              >
                                {isCursor() ? "▸ " : "  "}
                                {row.branch || t("worktrees.row.detached")}
                              </text>
                              {row.kobeManaged && <text fg={theme.textMuted}> {t("worktrees.badge.kobeManaged")}</text>}
                              {row.dirty && <text fg={theme.warning}> {t("worktrees.badge.dirty")}</text>}
                              {remoteBadge(row.branchOnRemote)}
                              {busyPath() === row.path && <text fg={theme.textMuted}> …</text>}
                            </box>
                            <box flexDirection="row" justifyContent="space-between" paddingLeft={2}>
                              <text fg={theme.textMuted} wrapMode="none">
                                {row.path}
                              </text>
                              {row.createdAtMs > 0 && (
                                <text fg={theme.textMuted} wrapMode="none">
                                  {t("worktrees.row.created", { age: relativeAge(row.createdAtMs) })}
                                </text>
                              )}
                            </box>
                          </box>
                        )
                      }}
                    </For>
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
      </Show>
    </scrollbox>
  )
}
