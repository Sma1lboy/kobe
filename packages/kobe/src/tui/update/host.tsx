/**
 * `kobe update-page` — update details as a standalone full-window tmux
 * surface.
 *
 * Direct-tmux startup made the old outer TUI update dialog effectively
 * stale. This page follows the Settings/New Task pattern: open a
 * dedicated tmux window, show the update context without cramped footer
 * copy, and hand off to the shell updater when the user chooses Update.
 */

import { spawn, spawnSync } from "node:child_process"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import {
  CURRENT_VERSION,
  type ReleaseNotesRangeItem,
  UPDATE_COMMAND,
  type UpdateInfo,
  checkLatestVersion,
  fetchReleaseNotesRange,
  releasePageUrl,
} from "../../version.ts"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"

type ActionId = "update" | "release" | "close"

function openExternalUrl(url: string | null): boolean {
  if (!url) return false
  const platform = process.platform
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true })
    child.unref()
    return true
  } catch {
    return false
  }
}

function releaseBodyLines(body: string): string[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function waitForKeypress(): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve()
  return new Promise((resolve) => {
    const stdin = process.stdin
    const done = () => {
      stdin.off("data", done)
      stdin.setRawMode?.(false)
      stdin.pause()
      resolve()
    }
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.once("data", done)
  })
}

function UpdatePage() {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [info, setInfo] = createSignal<UpdateInfo | null>(null)
  const [releaseNotes, setReleaseNotes] = createSignal<ReleaseNotesRangeItem[]>([])
  const [loadingNotes, setLoadingNotes] = createSignal(true)
  const [selected, setSelected] = createSignal<ActionId>("update")
  const [status, setStatus] = createSignal<string | null>(null)

  const latest = createMemo(() => info()?.latest ?? CURRENT_VERSION)
  const releaseUrl = createMemo(() => releaseNotes()[0]?.url ?? releasePageUrl(latest()))
  const actions = createMemo<ReadonlyArray<{ id: ActionId; key: string; label: string; detail: string }>>(() => [
    { id: "update", key: "U", label: t("update.actions.updateNow"), detail: UPDATE_COMMAND },
    {
      id: "release",
      key: "R",
      label: t("update.actions.openRelease"),
      detail: releaseUrl() ?? t("update.releaseUrlUnavailable"),
    },
    { id: "close", key: "Q", label: t("update.actions.close"), detail: t("update.actions.closeDetail") },
  ])

  onMount(() => {
    void load()
  })

  async function load(): Promise<void> {
    const next = await checkLatestVersion({ force: true })
    setInfo(next)
    const latestVersion = next?.latest ?? CURRENT_VERSION
    const fetched = await fetchReleaseNotesRange({ current: CURRENT_VERSION, latest: latestVersion })
    setReleaseNotes(fetched)
    setLoadingNotes(false)
  }

  function move(delta: number): void {
    const ids = actions().map((a) => a.id)
    const index = ids.indexOf(selected())
    const next = (index + delta + ids.length) % ids.length
    setSelected(ids[next] ?? "update")
  }

  function activate(id = selected()): void {
    if (id === "close") process.exit(0)
    if (id === "release") {
      setStatus(openExternalUrl(releaseUrl()) ? t("update.statusReleaseOpened") : t("update.statusReleaseError"))
      return
    }
    void runUpdater()
  }

  async function runUpdater(): Promise<void> {
    setStatus(t("update.statusRunningUpdater"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    renderer?.destroy()
    process.stdout.write(`\nkobe ${CURRENT_VERSION} -> ${latest()}\n`)
    process.stdout.write(`running: ${UPDATE_COMMAND}\n\n`)
    const result = spawnSync("sh", ["-c", UPDATE_COMMAND], { stdio: "inherit" })
    const code = result.status ?? (result.error ? 1 : 0)
    if (result.error) process.stderr.write(`\nkobe update: failed to start updater: ${result.error.message}\n`)
    process.stdout.write(
      code === 0 ? `\n${t("update.updateComplete")}\n` : `\n${t("update.updateFailed", { code: String(code) })}\n`,
    )
    process.stdout.write(t("update.pressAnyKey"))
    await waitForKeypress()
    process.exit(code)
  }

  useBindings(() => ({
    bindings: [
      { key: "up", cmd: () => move(-1) },
      { key: "down", cmd: () => move(1) },
      { key: "k", cmd: () => move(-1) },
      { key: "j", cmd: () => move(1) },
      { key: "return", cmd: () => activate() },
      { key: "u", cmd: () => activate("update") },
      { key: "r", cmd: () => activate("release") },
      { key: "q", cmd: () => activate("close") },
      { key: "escape", cmd: () => activate("close") },
      { key: "ctrl+c", cmd: () => activate("close") },
    ],
  }))

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      backgroundColor={theme.background}
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {t("update.pageTitle")}
        </text>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={() => activate("close")}>
          q / esc
        </text>
      </box>

      <box flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="none">
          {t("update.current")}
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          v{CURRENT_VERSION}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {t("update.latest")}
        </text>
        <text fg={info()?.hasUpdate ? theme.warning : theme.success} attributes={TextAttributes.BOLD} wrapMode="none">
          v{latest()}
        </text>
      </box>

      <box flexDirection="column" flexShrink={0} paddingTop={1} gap={0}>
        <For each={actions()}>
          {(action) => (
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={selected() === action.id ? theme.primary : undefined}
              onMouseUp={() => activate(action.id)}
            >
              <box width={4} flexShrink={0}>
                <text
                  fg={selected() === action.id ? theme.selectedListItemText : theme.accent}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                >
                  [{action.key}]
                </text>
              </box>
              <box width={14} flexShrink={0}>
                <text fg={selected() === action.id ? theme.selectedListItemText : theme.text} wrapMode="none">
                  {action.label}
                </text>
              </box>
              <text fg={selected() === action.id ? theme.selectedListItemText : theme.textMuted} wrapMode="word">
                {action.detail}
              </text>
            </box>
          )}
        </For>
      </box>

      <Show when={status()}>
        <text fg={theme.info} wrapMode="word">
          {status()}
        </text>
      </Show>

      <box flexShrink={0} paddingTop={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
          {t("update.changesSectionHeader", { from: CURRENT_VERSION, to: latest() })}
        </text>
      </box>
      <scrollbox
        flexGrow={1}
        flexShrink={1}
        stickyScroll={false}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
        }}
      >
        <box flexDirection="column" paddingRight={1} paddingBottom={1} gap={0}>
          <Show when={loadingNotes()}>
            <text fg={theme.textMuted}>{t("update.loadingNotes")}</text>
          </Show>
          <Show when={!loadingNotes() && releaseNotes().length === 0}>
            <text fg={theme.textMuted} wrapMode="word">
              {t("update.notesUnavailable")}
            </text>
          </Show>
          <For each={releaseNotes()}>
            {(release) => (
              <box flexDirection="column" paddingBottom={1} gap={0}>
                <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                  v{release.version}
                </text>
                <For each={releaseBodyLines(release.body)}>
                  {(line) => (
                    <text fg={theme.textMuted} wrapMode="word">
                      {line}
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}

export async function startUpdateHost(): Promise<void> {
  // No teardown and no daemon connection — this page only talks to npm /
  // GitHub and hands off to the shell updater.
  await bootPaneHost({
    setup: () => ({ root: () => <UpdatePage /> }),
  })
}
