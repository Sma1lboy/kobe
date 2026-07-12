/** @jsxImportSource @opentui/react */
/**
 * `kobe update --list` (TTY) — the versions browser. Same page framework
 * as the update page (bootPaneHost + pageCloseBindings): a j/k list of
 * recent GitHub releases with current/latest/breaking tags, the selected
 * release's notes in a scrollbox (fetched lazily per row, cached), and
 * Enter handing off to the shell updater pinned to the selected version.
 * Installing across a BREAKING_VERSIONS entry shows the `kobe reset`
 * warning in the detail footer before the user commits.
 */

import { TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useState } from "react"
import {
  BREAKING_VERSIONS,
  CURRENT_VERSION,
  type ReleaseNotes,
  type ReleaseSummary,
  UPDATE_COMMAND,
  breakingVersionsCrossed,
  fetchReleaseNotes,
  fetchReleaseSummaries,
} from "../../version.ts"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { pageCloseBindings, useBindings } from "../lib/keymap"
import { releaseBodyLines } from "./host.tsx"
import { runShellUpdater } from "./run-updater.ts"

const RELEASE_LIMIT = 20

type NotesCache = Record<string, ReleaseNotes | "loading" | "missing">

export function VersionsPage(props: { onClose: () => void }) {
  const { theme } = useTheme()
  const t = useT()
  const renderer = useRenderer()
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null)
  const [cursor, setCursor] = useState(0)
  const [notes, setNotes] = useState<NotesCache>({})
  const [status, setStatus] = useState<string | null>(null)

  const selected = releases?.[cursor]
  const crossings = selected ? breakingVersionsCrossed(CURRENT_VERSION, selected.version) : []

  useEffect(() => {
    void fetchReleaseSummaries(RELEASE_LIMIT).then((fetched) => setReleases(fetched))
  }, [])

  // Lazily fetch the selected row's notes (one release body per selection,
  // cached — the list fetch deliberately omits bodies to save API budget).
  const selectedVersion = selected?.version
  useEffect(() => {
    if (selectedVersion === undefined || notes[selectedVersion] !== undefined) return
    setNotes((cache) => ({ ...cache, [selectedVersion]: "loading" }))
    void fetchReleaseNotes(selectedVersion).then((fetched) => {
      setNotes((cache) => ({ ...cache, [selectedVersion]: fetched ?? "missing" }))
    })
  }, [selectedVersion, notes])

  function move(delta: number): void {
    const count = releases?.length ?? 0
    if (count === 0) return
    setCursor((index) => (index + delta + count) % count)
  }

  async function installSelected(): Promise<void> {
    if (!selected) return
    setStatus(t("update.statusRunningUpdater"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    await runShellUpdater({
      renderer,
      t,
      targetLabel: selected.version,
      command: `${UPDATE_COMMAND} -s -- ${selected.version}`,
    })
  }

  useBindings(() => ({
    bindings: [
      { key: "up", cmd: () => move(-1) },
      { key: "down", cmd: () => move(1) },
      { key: "k", cmd: () => move(-1) },
      { key: "j", cmd: () => move(1) },
      { key: "return", cmd: () => void installSelected() },
      { key: "u", cmd: () => void installSelected() },
      ...pageCloseBindings(props.onClose),
    ],
  }))

  const selectedNotes = selectedVersion === undefined ? undefined : notes[selectedVersion]

  return (
    // No backgroundColor: inline pages sit on the shell's own background.
    <box flexDirection="column" flexGrow={1} paddingTop={1} paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {t("update.versions.pageTitle")}
        </text>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={props.onClose}>
          q / esc
        </text>
      </box>

      <box flexDirection="row" flexGrow={1} paddingTop={1} gap={2}>
        <box flexDirection="column" width={26} flexShrink={0}>
          {releases === null ? <text fg={theme.textMuted}>{t("update.versions.loading")}</text> : null}
          {releases !== null && releases.length === 0 ? (
            <text fg={theme.textMuted} wrapMode="word">
              {t("update.versions.unavailable")}
            </text>
          ) : null}
          {(releases ?? []).map((release, index) => {
            const active = index === cursor
            const tags = [
              release.version === CURRENT_VERSION ? t("update.versions.tagCurrent") : "",
              index === 0 ? t("update.versions.tagLatest") : "",
              BREAKING_VERSIONS.includes(release.version) ? t("update.versions.tagBreaking") : "",
            ]
              .filter(Boolean)
              .join(" ")
            return (
              <box
                key={release.version}
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                backgroundColor={active ? theme.primary : undefined}
                onMouseUp={() => setCursor(index)}
              >
                <text
                  fg={active ? theme.selectedListItemText : theme.text}
                  attributes={release.version === CURRENT_VERSION ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  v{release.version}
                </text>
                {tags ? (
                  <text fg={active ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                    {tags}
                  </text>
                ) : null}
              </box>
            )
          })}
        </box>

        <box flexDirection="column" flexGrow={1} flexShrink={1}>
          <scrollbox
            flexGrow={1}
            flexShrink={1}
            stickyScroll={false}
            verticalScrollbarOptions={{
              trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
            }}
          >
            <box flexDirection="column" paddingRight={1} paddingBottom={1} gap={0}>
              {selectedNotes === "loading" ? <text fg={theme.textMuted}>{t("update.loadingNotes")}</text> : null}
              {selectedNotes === "missing" ? (
                <text fg={theme.textMuted} wrapMode="word">
                  {t("update.notesUnavailable")}
                </text>
              ) : null}
              {selectedNotes !== undefined && selectedNotes !== "loading" && selectedNotes !== "missing"
                ? releaseBodyLines(selectedNotes.body).map((line, i) => (
                    <text key={`${i}:${line}`} fg={theme.textMuted} wrapMode="word">
                      {line}
                    </text>
                  ))
                : null}
            </box>
          </scrollbox>
          {crossings.length > 0 ? (
            <text fg={theme.warning} wrapMode="word">
              {t("update.versions.breakingWarning", { versions: crossings.join(", ") })}
            </text>
          ) : null}
        </box>
      </box>

      {status ? (
        <text fg={theme.info} wrapMode="word">
          {status}
        </text>
      ) : null}

      <box flexShrink={0} paddingTop={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
          {t("update.versions.footerHint")}
        </text>
      </box>
    </box>
  )
}

/** Footer rows for the inline browser: title + 20 releases + hints. */
const INLINE_ROWS = 24

export async function startVersionsHost(): Promise<void> {
  // Same contract as startUpdateHost: no daemon, npm/GitHub only; closing
  // exits the process (the launching terminal gets its prompt back).
  // Inline (main-screen footer) — a CLI subcommand should feel like a
  // prompt, not a fullscreen app; the shell scrollback stays visible.
  await bootPaneHost({
    inlineRows: INLINE_ROWS,
    setup: () => ({ root: () => <VersionsPage onClose={() => process.exit(0)} /> }),
  })
}
