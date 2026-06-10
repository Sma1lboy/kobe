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
  type ReleaseNotes,
  UPDATE_COMMAND,
  type UpdateInfo,
  checkLatestVersion,
  fetchReleaseNotes,
  releasePageUrl,
} from "../../version.ts"
import { useTheme } from "../context/theme"
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
    .slice(0, 40)
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
  const [notes, setNotes] = createSignal<ReleaseNotes | null>(null)
  const [loadingNotes, setLoadingNotes] = createSignal(true)
  const [selected, setSelected] = createSignal<ActionId>("update")
  const [status, setStatus] = createSignal<string | null>(null)

  const latest = createMemo(() => info()?.latest ?? CURRENT_VERSION)
  const releaseUrl = createMemo(() => notes()?.url ?? releasePageUrl(latest()))
  const lines = createMemo(() => releaseBodyLines(notes()?.body ?? ""))
  const actions = createMemo<ReadonlyArray<{ id: ActionId; key: string; label: string; detail: string }>>(() => [
    { id: "update", key: "U", label: "Update now", detail: UPDATE_COMMAND },
    { id: "release", key: "R", label: "Open release", detail: releaseUrl() ?? "release URL unavailable" },
    { id: "close", key: "Q", label: "Close", detail: "return to the previous tmux window" },
  ])

  onMount(() => {
    void load()
  })

  async function load(): Promise<void> {
    const next = await checkLatestVersion({ force: true })
    setInfo(next)
    const version = next?.latest ?? CURRENT_VERSION
    const fetched = await fetchReleaseNotes(version)
    setNotes(fetched)
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
      setStatus(openExternalUrl(releaseUrl()) ? "Opened release page in your browser." : "Could not open release URL.")
      return
    }
    void runUpdater()
  }

  async function runUpdater(): Promise<void> {
    setStatus("Leaving the TUI page and running the updater in this tmux window...")
    await new Promise((resolve) => setTimeout(resolve, 30))
    renderer?.destroy()
    process.stdout.write(`\nkobe ${CURRENT_VERSION} -> latest\n`)
    process.stdout.write(`running: ${UPDATE_COMMAND}\n\n`)
    const result = spawnSync("sh", ["-c", UPDATE_COMMAND], { stdio: "inherit" })
    const code = result.status ?? (result.error ? 1 : 0)
    if (result.error) process.stderr.write(`\nkobe update: failed to start updater: ${result.error.message}\n`)
    process.stdout.write(
      code === 0
        ? "\nkobe update complete. Relaunch kobe to use the new version.\n"
        : `\nkobe update failed with exit code ${code}.\n`,
    )
    process.stdout.write("Press any key to close this update window.")
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
          KOBE UPDATE
        </text>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={() => activate("close")}>
          q / esc
        </text>
      </box>

      <box flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="none">
          current
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          v{CURRENT_VERSION}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          latest
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
          ── release notes ──
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
            <text fg={theme.textMuted}>Loading release notes...</text>
          </Show>
          <Show when={!loadingNotes() && lines().length === 0}>
            <text fg={theme.textMuted} wrapMode="word">
              Release notes are unavailable. Use Open release to view the GitHub release page.
            </text>
          </Show>
          <For each={lines()}>
            {(line) => (
              <text fg={theme.textMuted} wrapMode="word">
                {line}
              </text>
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
