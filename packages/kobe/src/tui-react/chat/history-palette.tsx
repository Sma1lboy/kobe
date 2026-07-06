/** @jsxImportSource @opentui/react */
/**
 * React Ctrl+R cross-task prompt-history palette — the
 * `src/tui/chat/composer/HistoryPalette.tsx` + `history-palette-controller.tsx`
 * counterpart (issue #15 G3, KOB-154 feature). Aggregates every entry from
 * the shared on-disk prompt-history store, filters by a fuzzy substring
 * query, and resolves with the selected entry's raw stored value
 * (`!`-prefixed for bash-mode submissions) or `undefined` on cancel.
 */

import { TextAttributes } from "@opentui/core"
import { useMemo, useState } from "react"
import { makeDropdownWindow } from "../../tui/chat/composer/dropdown-window"
import { getAllHistoryEntries } from "../../tui/chat/composer/history"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

/** Maximum visible rows in the palette body. Bigger than the slash dropdown
 * because cross-task history is the entire raison d'être here. */
const PALETTE_MAX_ROWS = 12

/**
 * One palette row. `value` is the raw stored form (`!cmd` for bash);
 * `display` is the stripped form rendered in the row body.
 */
type PaletteRow = {
  readonly value: string
  readonly display: string
  readonly isBash: boolean
  readonly taskLabel: string | undefined
  readonly seq: number
}

function rowsFromEntries(
  entries: ReadonlyArray<{
    readonly key: string
    readonly value: string
    readonly seq: number
    readonly project: string | undefined
  }>,
  labelFor: (key: string) => string | undefined,
  currentProject: string | undefined,
): PaletteRow[] {
  // Per-project scope (Claude Code parity, KOB-157). When a current project
  // is known, hide rows from other repos; no current project falls back to
  // "show every project + global" so the palette is never silently empty.
  const filtered =
    currentProject === undefined
      ? entries
      : entries.filter((e) => e.project === currentProject || e.project === undefined)
  return filtered.map((e) => {
    const isBash = e.value.startsWith("!")
    return {
      value: e.value,
      display: isBash ? e.value.slice(1) : e.value,
      isBash,
      taskLabel: labelFor(e.key),
      seq: e.seq,
    }
  })
}

function fuzzyFilter(rows: readonly PaletteRow[], query: string): PaletteRow[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return rows.slice()
  return rows.filter((r) => {
    const hay = `${r.taskLabel ?? ""} ${r.display}`.toLowerCase()
    return hay.includes(q)
  })
}

/** Truncate `text` to `max` characters, appending `…` when it had to clip. */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ")
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

export function HistoryPaletteView(props: {
  taskLabelFor: (historyKey: string) => string | undefined
  currentProject: string | undefined
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  // Snapshot entries on open — the palette is short-lived, and a stable list
  // keeps the cursor sane across the user's typing.
  const [allRows] = useState(() => rowsFromEntries(getAllHistoryEntries(), props.taskLabelFor, props.currentProject))
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)

  const matches = useMemo(() => fuzzyFilter(allRows, query), [allRows, query])
  const window = useMemo(() => makeDropdownWindow(matches, cursor, PALETTE_MAX_ROWS), [matches, cursor])

  function commit(atIndex?: number): void {
    const row = matches[atIndex ?? cursor]
    if (!row) return
    props.onSubmit(row.value)
    dialog.clear()
  }

  function moveCursor(delta: number): void {
    const len = matches.length
    if (len === 0) return
    setCursor((cur) => Math.min(Math.max(cur + delta, 0), len - 1))
  }

  // Up/down nav lives in `useBindings` because the focused <input> doesn't
  // let us intercept arrows; the dispatcher fires BEFORE the input reacts.
  useBindings(() => ({
    bindings: [
      { key: "up", cmd: () => moveCursor(-1) },
      { key: "down", cmd: () => moveCursor(1) },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {t("chat.composer.historyTitle")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          {t("chat.composer.esc")}
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>{t("chat.composer.historySearch")}</text>
        <input
          value={query}
          placeholder={t("chat.composer.historyFilterPlaceholder")}
          focused={true}
          onInput={(v: string) => {
            setQuery(v.replace(/\n/g, ""))
            // Reset to the top of the filtered list whenever the query
            // changes — otherwise the cursor can point past the end.
            setCursor(0)
          }}
          onSubmit={() => commit()}
        />
      </box>
      {matches.length > 0 ? (
        <box gap={0}>
          {window.items.map((row, idx) => {
            const absIdx = window.start + idx
            const isHighlighted = absIdx === cursor
            return (
              <box
                key={`${row.seq}:${row.value}`}
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isHighlighted ? theme.primary : undefined}
                onMouseUp={() => {
                  setCursor(absIdx)
                  commit(absIdx)
                }}
              >
                {row.isBash ? (
                  <text fg={isHighlighted ? theme.selectedListItemText : theme.warning} wrapMode="none">
                    [bash]
                  </text>
                ) : null}
                {row.taskLabel !== undefined ? (
                  <>
                    <text fg={isHighlighted ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                      {row.taskLabel}
                    </text>
                    <text fg={isHighlighted ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                      ·
                    </text>
                  </>
                ) : null}
                <text fg={isHighlighted ? theme.selectedListItemText : theme.text} wrapMode="none" flexGrow={1}>
                  {truncate(row.display, 80)}
                </text>
              </box>
            )
          })}
          {window.total > window.items.length ? (
            <text fg={theme.textMuted}>
              {window.total - window.items.length} more match
              {window.total - window.items.length === 1 ? "" : "es"} hidden — keep typing or scroll
            </text>
          ) : null}
        </box>
      ) : (
        <box paddingBottom={1}>
          <text fg={theme.textMuted}>
            {allRows.length === 0 ? t("chat.composer.historyEmpty") : t("chat.composer.historyNoMatches")}
          </text>
        </box>
      )}
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{t("chat.composer.historyHint")}</text>
      </box>
    </box>
  )
}

/**
 * Promise-shaped entry point, mirroring the Solid
 * `history-palette-controller` so the shared key-router's
 * `showHistoryPalette` seam wires up identically on both sides.
 */
export const HistoryPalette = {
  show(
    dialog: DialogContext,
    opts: {
      readonly taskLabelFor: (historyKey: string) => string | undefined
      readonly currentProject: string | undefined
    },
  ): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      dialog.replace(
        () => (
          <HistoryPaletteView
            taskLabelFor={opts.taskLabelFor}
            currentProject={opts.currentProject}
            onSubmit={(v) => resolve(v)}
            onCancel={() => resolve(undefined)}
          />
        ),
        () => resolve(undefined),
      )
    })
  },
}
