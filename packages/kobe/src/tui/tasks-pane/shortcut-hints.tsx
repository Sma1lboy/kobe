import { runTmuxCapturing } from "@/tmux/client"
import { t } from "@/tui/i18n"
import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createSignal, onMount } from "solid-js"
import { TMUX_FOCUS_DEFAULTS, resolveUserTmuxKeys } from "../../tmux/keybindings.ts"
import { findBinding, keymapVersion } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { formatChord, tmuxPrefixGlyph } from "../lib/chord-glyphs"
import { approxCellWidth } from "../panes/sidebar/hover-tooltip"

export function legendCap(id: string): string | null {
  const row = findBinding(id)
  if (!row) return null
  const cap = row.hint?.keys ?? row.keys[0]
  return cap && cap.length > 0 ? cap : null
}

export function legendRowCap(ids: readonly string[]): string | null {
  const caps = ids.map(legendCap).filter((c): c is string => c !== null)
  return caps.length > 0 ? caps.join("/") : null
}

export function ShortcutHints(props: {
  moveMode?: Accessor<boolean>
  selectedIsMain?: Accessor<boolean>
  collapsed?: Accessor<boolean>
  onToggleCollapsed?: () => void
}) {
  const { theme } = useTheme()
  const [prefixCap, setPrefixCap] = createSignal("Prefix")
  onMount(() => {
    void runTmuxCapturing(["show-options", "-g", "prefix"]).then(({ code, stdout }) => {
      if (code !== 0) return
      const glyph = tmuxPrefixGlyph(stdout)
      if (glyph) setPrefixCap(glyph)
    })
  })
  type Hint = { k: string; label: string; dimWhenMain?: boolean }
  const tmuxHints = (): ReadonlyArray<Hint> => {
    keymapVersion()
    const res = resolveUserTmuxKeys()
    const b = res.binds
    const out: Hint[] = []
    const focusChords = res.focus.filter((f): f is NonNullable<typeof f> => f !== null).map((f) => f.chord)
    if (focusChords.length === 4 && focusChords.every((c, i) => c === TMUX_FOCUS_DEFAULTS[i])) {
      out.push({ k: "ctrl+hjkl", label: t("tasks.hints.movePanes") })
    } else if (focusChords.length > 0) {
      out.push({ k: focusChords[0] as string, label: t("tasks.hints.movePanes") })
    }
    const layoutGroup = (label: string, ids: readonly (keyof typeof b)[]): void => {
      const chords = ids.map((id) => b[id]?.chord).filter((chord): chord is string => !!chord)
      if (chords.length > 0) out.push({ k: `prefix ${chords.join("/")}`, label })
    }
    if (b["tmux.detach"]) out.push({ k: b["tmux.detach"].chord, label: t("tasks.hints.detach") })
    layoutGroup(t("tasks.hints.splits"), [
      "tmux.layout.workspaceSplit",
      "tmux.layout.workspaceClose",
      "tmux.layout.workspaceReset",
    ])
    layoutGroup(t("tasks.hints.panes"), [
      "tmux.layout.tasksToggle",
      "tmux.layout.opsToggle",
      "tmux.layout.terminalToggle",
    ])
    return out
  }
  const defaultHints = (): ReadonlyArray<Hint> => {
    keymapVersion()
    const rows: Array<{ ids: readonly string[]; label: string; dimWhenMain?: boolean }> = [
      { ids: ["help.open"], label: t("tasks.hints.fullHelp") },
      { ids: ["task.new"], label: t("tasks.hints.newTask") },
      { ids: ["settings.open.sidebar"], label: t("tasks.hints.settings") },
      { ids: ["sidebar.select"], label: t("tasks.hints.open") },
      { ids: ["tasks.focusEngine"], label: t("tasks.hints.focusEngine") },
      { ids: ["tasks.openWorktree"], label: t("tasks.hints.openWorktree") },
      { ids: ["sidebar.delete"], label: t("tasks.hints.delete") },
      { ids: ["sidebar.view"], label: t("tasks.hints.views") },
      { ids: ["sidebar.projectFilter"], label: t("tasks.hints.project") },
    ]
    const out: Hint[] = []
    for (const row of rows) {
      const k = legendRowCap(row.ids)
      if (k === null) continue
      out.push({ k, label: row.label, dimWhenMain: row.dimWhenMain })
    }
    out.push(...tmuxHints())
    return out
  }
  const MOVE_HINTS = (): ReadonlyArray<Hint> => [
    { k: "j/k", label: t("tasks.hints.reorder") },
    { k: "enter/esc", label: t("tasks.hints.done") },
  ]
  const hints = () => (props.moveMode?.() ? MOVE_HINTS() : defaultHints())
  const LABEL_COL_MAX = 18
  const labelColWidth = () => Math.min(LABEL_COL_MAX, Math.max(...hints().map((h) => approxCellWidth(h.label))))
  const clipLabel = (s: string): string => {
    const cells = labelColWidth()
    if (approxCellWidth(s) <= cells) return s
    const points = [...s]
    let used = 0
    let cut = 0
    for (const ch of points) {
      const w = (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1
      if (used + w > cells - 1) break
      used += w
      cut++
    }
    return `${points.slice(0, cut).join("")}…`
  }
  const folded = () => (props.collapsed?.() ?? false) && !(props.moveMode?.() ?? false)
  return (
    <box
      flexShrink={0}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={0}
    >
      {}
      <text
        fg={theme.textMuted}
        attributes={TextAttributes.DIM}
        wrapMode="none"
        onMouseUp={() => props.onToggleCollapsed?.()}
      >
        {folded() ? t("tasks.hints.headerFolded") : t("tasks.hints.headerUnfolded")}
      </text>
      <Show when={!folded()}>
        <For each={hints()}>
          {(h) => {
            const dim = () => h.dimWhenMain === true && (props.selectedIsMain?.() ?? false)
            return (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                {}
                <box width={10} flexShrink={0}>
                  <text
                    fg={dim() ? theme.textMuted : theme.accent}
                    attributes={dim() ? TextAttributes.DIM : TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    [{formatChord(h.k, prefixCap())}]
                  </text>
                </box>
                {}
                <box width={labelColWidth()} flexShrink={0}>
                  <text fg={theme.textMuted} attributes={dim() ? TextAttributes.DIM : undefined} wrapMode="none">
                    {clipLabel(h.label)}
                  </text>
                </box>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}
