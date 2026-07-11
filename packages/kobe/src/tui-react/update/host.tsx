/** @jsxImportSource @opentui/react */
/**
 * `kobe update-page` — React port of `src/tui/update/host.tsx` (the Solid
 * host removed in 7a5b878d). React is the default runtime since 2026-07-07
 * (`uiFramework()` in `src/env.ts`). Same contract: update details as a
 * standalone full-window tmux surface.
 *
 * Direct-tmux startup made the old outer TUI update dialog effectively
 * stale. This page follows the Settings/New Task pattern: open a
 * dedicated tmux window, show the update context without cramped footer
 * copy, and hand off to the shell updater when the user chooses Update.
 *
 * `onClose` seam (daemon issue #23 remainder): `UpdatePage` now takes an
 * `{ onClose }` prop — same shape as `WorktreesPage` — so the pure-tui
 * workspace host (`tui-react/workspace/host.tsx`) can mount it as an
 * in-place swap instead of only living behind the standalone
 * `kobe update-page` tmux window. The close ("q"/esc/Ctrl+C/[Close] action)
 * path calls `onClose()` instead of `process.exit(0)`. The post-update
 * self-replace exit is UNCHANGED: `runUpdater()` still destroys the
 * renderer and `process.exit(code)`s after the shell updater completes —
 * an embedded swap can't survive that any more than a standalone window
 * can, so it stays, with a status line surfaced first so the swap-hosted
 * case doesn't just vanish without explanation. `startUpdateHost` (the
 * standalone launch path) passes `onClose: () => process.exit(0)`,
 * preserving its exact previous behavior.
 */

import { spawn, spawnSync } from "node:child_process"
import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useState } from "react"
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
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { pageCloseBindings, useBindings } from "../lib/keymap"

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

export function UpdatePage(props: { onClose: () => void }) {
  const { theme } = useTheme()
  const t = useT()
  const renderer = useRenderer()
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotesRangeItem[]>([])
  const [loadingNotes, setLoadingNotes] = useState(true)
  const [selected, setSelected] = useState<ActionId>("update")
  const [status, setStatus] = useState<string | null>(null)

  const latest = info?.latest ?? CURRENT_VERSION
  const releaseUrl = releaseNotes[0]?.url ?? releasePageUrl(latest)
  const actions: ReadonlyArray<{ id: ActionId; key: string; label: string; detail: string }> = [
    { id: "update", key: "U", label: t("update.actions.updateNow"), detail: UPDATE_COMMAND },
    {
      id: "release",
      key: "R",
      label: t("update.actions.openRelease"),
      detail: releaseUrl ?? t("update.releaseUrlUnavailable"),
    },
    { id: "close", key: "Q", label: t("update.actions.close"), detail: t("update.actions.closeDetail") },
  ]

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function load(): Promise<void> {
    const next = await checkLatestVersion({ force: true })
    setInfo(next)
    const latestVersion = next?.latest ?? CURRENT_VERSION
    const fetched = await fetchReleaseNotesRange({ current: CURRENT_VERSION, latest: latestVersion })
    setReleaseNotes(fetched)
    setLoadingNotes(false)
  }

  function move(delta: number): void {
    const ids = actions.map((a) => a.id)
    const index = ids.indexOf(selected)
    const next = (index + delta + ids.length) % ids.length
    setSelected(ids[next] ?? "update")
  }

  function activate(id: ActionId = selected): void {
    if (id === "close") {
      props.onClose()
      return
    }
    if (id === "release") {
      setStatus(openExternalUrl(releaseUrl) ? t("update.statusReleaseOpened") : t("update.statusReleaseError"))
      return
    }
    void runUpdater()
  }

  async function runUpdater(): Promise<void> {
    setStatus(t("update.statusRunningUpdater"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    renderer?.destroy()
    process.stdout.write(`\nkobe ${CURRENT_VERSION} -> ${latest}\n`)
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
      ...pageCloseBindings(() => activate("close")),
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
        <text fg={info?.hasUpdate ? theme.warning : theme.success} attributes={TextAttributes.BOLD} wrapMode="none">
          v{latest}
        </text>
      </box>

      <box flexDirection="column" flexShrink={0} paddingTop={1} gap={0}>
        {actions.map((action) => (
          <box
            key={action.id}
            flexDirection="row"
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={selected === action.id ? theme.primary : undefined}
            onMouseUp={() => activate(action.id)}
          >
            <box width={4} flexShrink={0}>
              <text
                fg={selected === action.id ? theme.selectedListItemText : theme.accent}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
              >
                [{action.key}]
              </text>
            </box>
            <box width={14} flexShrink={0}>
              <text fg={selected === action.id ? theme.selectedListItemText : theme.text} wrapMode="none">
                {action.label}
              </text>
            </box>
            <text fg={selected === action.id ? theme.selectedListItemText : theme.textMuted} wrapMode="word">
              {action.detail}
            </text>
          </box>
        ))}
      </box>

      {status ? (
        <text fg={theme.info} wrapMode="word">
          {status}
        </text>
      ) : null}

      <box flexShrink={0} paddingTop={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
          {t("update.changesSectionHeader", { from: CURRENT_VERSION, to: latest })}
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
          {loadingNotes ? <text fg={theme.textMuted}>{t("update.loadingNotes")}</text> : null}
          {!loadingNotes && releaseNotes.length === 0 ? (
            <text fg={theme.textMuted} wrapMode="word">
              {t("update.notesUnavailable")}
            </text>
          ) : null}
          {releaseNotes.map((release) => (
            <box key={release.version} flexDirection="column" paddingBottom={1} gap={0}>
              <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                v{release.version}
              </text>
              {releaseBodyLines(release.body).map((line, i) => (
                <text key={`${i}:${line}`} fg={theme.textMuted} wrapMode="word">
                  {line}
                </text>
              ))}
            </box>
          ))}
        </box>
      </scrollbox>
    </box>
  )
}

export async function startUpdateHost(): Promise<void> {
  // No teardown and no daemon connection — this page only talks to npm /
  // GitHub and hands off to the shell updater. Standalone launch keeps its
  // exact previous close behavior: exit the process (tmux closes the window).
  await bootPaneHost({
    setup: () => ({ root: () => <UpdatePage onClose={() => process.exit(0)} /> }),
  })
}
