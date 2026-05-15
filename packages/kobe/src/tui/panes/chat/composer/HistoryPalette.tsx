/**
 * Ctrl+R cross-task prompt-history palette (KOB-154).
 *
 * Aggregates every entry from {@link getAllHistoryEntries} (across
 * every task/tab), filters by a fuzzy substring query, and resolves
 * with the selected entry's raw stored value — `!`-prefixed for
 * bash-mode submissions so the caller (Composer) can route the recall
 * through the same KOB-151 logic that up-arrow uses.
 *
 * Behavior:
 *   - Cursor starts at row 0 (most recent submission overall).
 *   - Up/down nav; Enter resolves with the row's value; Esc resolves
 *     with `undefined`.
 *   - Empty history shows a one-line muted hint ("No prompt history
 *     yet.").
 *   - Bash entries (`!cmd`) render with a `[bash]` tag in
 *     `theme.warning` and the `!` stripped from the display body
 *     (still included in the resolved value).
 *
 * Sized small (`dialog.setSize("small")` is too tight at 50 cols, but
 * the default 80-col medium is a good fit for the title + prompt
 * snippet rows). Keeps the visual chrome consistent with the other
 * single-purpose dialogs in `component/*`.
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useTheme } from "../../../context/theme"
import { useBindings } from "../../../lib/keymap"
import { useDialog } from "../../../ui/dialog"
import { getAllHistoryEntries } from "./history"

/** Maximum visible rows in the palette body. Bigger than the slash dropdown
 * because cross-task history is the entire raison d'être here. */
const PALETTE_MAX_ROWS = 12

/**
 * One palette row. `value` is the raw stored form (`!cmd` for bash);
 * `display` is the stripped form rendered in the row body. `isBash`
 * drives the leading tag.
 */
type PaletteRow = {
  readonly value: string
  readonly display: string
  readonly isBash: boolean
  readonly taskLabel: string | undefined
  readonly seq: number
}

function rowsFromEntries(
  entries: ReadonlyArray<{ readonly key: string; readonly value: string; readonly seq: number }>,
  labelFor: (key: string) => string | undefined,
): PaletteRow[] {
  return entries.map((e) => {
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
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  // Snapshot entries on open. The palette is short-lived; if the user
  // submits a prompt while the palette is open they can re-open to see
  // the newest one. Keeps the cursor stable across the user's typing.
  const allRows = rowsFromEntries(getAllHistoryEntries(), props.taskLabelFor)
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)

  const matches = createMemo(() => fuzzyFilter(allRows, query()))
  const window = createMemo(() => {
    const list = matches()
    if (list.length <= PALETTE_MAX_ROWS) return { items: list, start: 0, total: list.length }
    const half = Math.floor(PALETTE_MAX_ROWS / 2)
    let start = Math.max(0, cursor() - half)
    if (start + PALETTE_MAX_ROWS > list.length) start = list.length - PALETTE_MAX_ROWS
    return { items: list.slice(start, start + PALETTE_MAX_ROWS), start, total: list.length }
  })

  function commit(): void {
    const list = matches()
    const row = list[cursor()]
    if (!row) return
    props.onSubmit(row.value)
    dialog.clear()
  }

  function moveCursor(delta: number): void {
    const len = matches().length
    if (len === 0) return
    setCursor((cur) => {
      const next = cur + delta
      if (next < 0) return 0
      if (next >= len) return len - 1
      return next
    })
  }

  // Up/down nav lives in `useBindings` because the focused <input>
  // doesn't expose an onKeyPress and we can't intercept arrows there.
  // The dispatcher fires these BEFORE the input would react, so the
  // single-line input never sees up/down at all — exactly what we want.
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
          Prompt history
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>search</text>
        <input
          value={query()}
          placeholder="filter by task name or prompt text"
          focused={true}
          onInput={(v: string) => {
            setQuery(v.replace(/\n/g, ""))
            // Reset to the top of the filtered list whenever the
            // query changes — otherwise typing can leave the cursor
            // pointing past the end and Enter resolves nothing.
            setCursor(0)
          }}
          onSubmit={() => commit()}
        />
      </box>
      <Show
        when={matches().length > 0}
        fallback={
          <box paddingBottom={1}>
            <text fg={theme.textMuted}>
              {allRows.length === 0 ? "No prompt history yet." : "No matches."}
            </text>
          </box>
        }
      >
        <box gap={0}>
          <For each={window().items}>
            {(row, idx) => {
              const absIdx = window().start + idx()
              const isHighlighted = () => absIdx === cursor()
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={isHighlighted() ? theme.primary : undefined}
                  onMouseUp={() => {
                    setCursor(absIdx)
                    commit()
                  }}
                >
                  <Show when={row.isBash}>
                    <text fg={isHighlighted() ? theme.selectedListItemText : theme.warning} wrapMode="none">
                      [bash]
                    </text>
                  </Show>
                  <Show when={row.taskLabel !== undefined}>
                    <text fg={isHighlighted() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                      {row.taskLabel ?? ""}
                    </text>
                    <text fg={isHighlighted() ? theme.selectedListItemText : theme.textMuted} wrapMode="none">
                      ·
                    </text>
                  </Show>
                  <text
                    fg={isHighlighted() ? theme.selectedListItemText : theme.text}
                    wrapMode="none"
                    flexGrow={1}
                  >
                    {truncate(row.display, 80)}
                  </text>
                </box>
              )
            }}
          </For>
          <Show when={window().total > window().items.length}>
            <text fg={theme.textMuted}>
              {window().total - window().items.length} more match{window().total - window().items.length === 1 ? "" : "es"} hidden — keep typing or scroll
            </text>
          </Show>
        </box>
      </Show>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>↑/↓ nav · enter recall · esc cancel</text>
      </box>
    </box>
  )
}
