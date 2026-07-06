/**
 * The Tasks pane's bottom shortcut legend — split out of `host.tsx` (which
 * was over the repo's 500-line file-size cap) into its own file. Same
 * behavior, moved verbatim: a self-contained component (only `Accessor`
 * props in, no writes back into `TasksShell`'s closure).
 */

import { runTmuxCapturing } from "@/tmux/client"
import { t } from "@/tui/i18n"
import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createSignal, onMount } from "solid-js"
import { TMUX_FOCUS_DEFAULTS, resolveUserTmuxKeys } from "../../tmux/keybindings.ts"
import { findBinding, keymapVersion } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { formatChord, tmuxPrefixGlyph } from "../lib/chord-glyphs"
import { approxCellWidth } from "../panes/sidebar/hover-tooltip"

/**
 * Resolve a single binding id to the chord cap the footer should advertise:
 * the cosmetic `hint.keys` when present (it's refreshed in place on an
 * override — keymap-overrides.ts), else the canonical first chord. Returns
 * `null` when the id is unbound (no chords) — the row that owns it should
 * then drop, since advertising a dead chord is worse than none (mirrors the
 * override path that nulls a hint on unbind).
 *
 * Pure + exported so the legend derivation is unit-testable against a faked
 * keymap without booting a tmux pane (the host itself isn't CI-runnable).
 */
export function legendCap(id: string): string | null {
  const row = findBinding(id)
  if (!row) return null
  const cap = row.hint?.keys ?? row.keys[0]
  return cap && cap.length > 0 ? cap : null
}

/**
 * Resolve a (possibly composite) legend row's keycap from the binding ids it
 * represents. Each id contributes its {@link legendCap}; unbound ids drop out
 * and the survivors join with `/` (so `r/b/v` becomes `r/v` if `b` is
 * unbound, or the whole row drops when nothing survives). Returns `null` when
 * every id resolved to no chord — the caller drops the row entirely.
 */
export function legendRowCap(ids: readonly string[]): string | null {
  const caps = ids.map(legendCap).filter((c): c is string => c !== null)
  return caps.length > 0 ? caps.join("/") : null
}

/**
 * A small shortcut legend pinned to the bottom of the Tasks pane:
 * shows the in-pane task actions plus the session-level tmux chords so the
 * keys are discoverable without leaving the pane. The `ctrl+h/j/k/l` and
 * `ctrl+[/]` lines are tmux session bindings — shown here, not rebound.
 *
 * Collapsible: the legend is ~20 rows with the tmux chords included, which
 * crowds the task list on short terminals. `?` (or clicking the header)
 * folds it down to the header line; move-mode hints ignore the fold — a
 * user inside reorder mode must always see how to leave it.
 */
export function ShortcutHints(props: {
  moveMode?: Accessor<boolean>
  selectedIsMain?: Accessor<boolean>
  collapsed?: Accessor<boolean>
  onToggleCollapsed?: () => void
}) {
  const { theme } = useTheme()
  // Resolve the user's REAL tmux prefix at runtime (#12). kobe loads the
  // user's own prefix, so a literal `Prefix F` is un-actionable — the user may
  // not know their prefix is C-a. Shell `tmux show-options -g prefix` on the
  // -L kobe socket (runTmuxCapturing already targets it) and render `C-b` as
  // `⌃B`. Falls back to the literal `Prefix` when resolution fails / is flaky.
  const [prefixCap, setPrefixCap] = createSignal("Prefix")
  onMount(() => {
    void runTmuxCapturing(["show-options", "-g", "prefix"]).then(({ code, stdout }) => {
      if (code !== 0) return
      const glyph = tmuxPrefixGlyph(stdout)
      if (glyph) setPrefixCap(glyph)
    })
  })
  // A hint row. `k` is a MACHINE chord string (`ctrl+q`, `prefix f`, `a/d`);
  // it's rendered as macOS glyphs via `formatChord` at draw time, so the
  // footer, the F1 help, and the status bar all read the same (one formatter,
  // no drift). `dimWhenMain` flags a keycap whose action early-returns on a
  // `main` (project root) row — the footer dims that cap so a press there reads
  // as "doesn't apply here" rather than a silent no-op (Issue #7).
  type Hint = { k: string; label: string; dimWhenMain?: boolean }
  // tmux session-key rows derive from the RESOLVED key set so user
  // overrides (`tmux.*` ids in ~/.kobe/settings/keybindings.yaml) show
  // their own chords here; an unbound id drops its row. Pseudo-chords
  // ("ctrl+hjkl", "ctrl+[/]") are kept only while the relevant keys are
  // still at their defaults — overridden keys render as plain chords.
  const tmuxHints = (): ReadonlyArray<Hint> => {
    // Re-derive after a live keybindings reload: the bump invalidates this
    // accessor so the footer re-renders with the freshly-resolved tmux
    // chords (the resolver's cache is cleared in the same reload).
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
    // Trimmed legend: keep pane movement, the tasks→detach chord, and the two
    // tmux-prefix layout groups. Per-tab rows (switch / new / engine / rename /
    // close) live in F1 full help, not the footer.
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
  // Fixed-width key column so labels line up — a terminal-grammar legend
  // column, not a proportional pane (allowed hardcode). formatChord keeps
  // plain-letter caps lowercase (the EXACT key to press, #14), uppercases the
  // key of modifier chords (`⌃ Q`), shows `tab` as a word, and renders the two
  // `prefix …` rows with the user's REAL resolved prefix (`prefixCap()`, #12).
  // Derived (not a static const) so those rows re-render once the async prefix
  // resolution lands.
  // Each in-pane row's keycap is DERIVED from KobeKeymap (legendRowCap) so a
  // user override / unbind in ~/.kobe/settings/keybindings.yaml is reflected
  // here — the footer is the only always-visible legend, and the doc promises
  // it follows the keymap (docs/KEYBINDINGS.md). The ids mirror a curated
  // subset of the pane's bindings plus the Sidebar-owned sidebar.* rows it
  // delegates to (Enter→sidebar.select, [/]→sidebar.view, d→sidebar.delete).
  // `keymapVersion()` is read at the top so a live reload re-renders the
  // legend with the freshly-resolved chords — same pattern as tmuxHints().
  // Each row is conditional: an id that resolved to no chord (unbound) drops
  // its row rather than advertising a dead key.
  const defaultHints = (): ReadonlyArray<Hint> => {
    keymapVersion()
    // Trimmed legend (KOB request): the footer carries only the high-traffic
    // rows; everything else (sort, move/merge, archive, rename/branch/engine,
    // per-tab tmux chords) is reachable via F1 full help. Order here is the
    // exact order the rows render in.
    const rows: Array<{ ids: readonly string[]; label: string; dimWhenMain?: boolean }> = [
      { ids: ["help.open"], label: t("tasks.hints.fullHelp") },
      { ids: ["task.new"], label: t("tasks.hints.newTask") },
      { ids: ["settings.open.sidebar"], label: t("tasks.hints.settings") },
      { ids: ["sidebar.select"], label: t("tasks.hints.open") },
      // Right arrow re-focuses the current window's engine pane
      // (tasks.focusEngine) — renders as [→] via formatChord's KEY_GLYPH.
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
  // Width of the description column = the longest label, but CAPPED so a long
  // label can't blow the column out past what the 32-cell Tasks pane (minus the
  // 10-cell keycap column) can hold. Each row right-aligns this fixed-width box
  // (text left-aligned inside), so every description shares one left edge AND
  // the whole column hugs the pane's right side. Labels longer than the cap are
  // ellipsised rather than allowed to overflow.
  const LABEL_COL_MAX = 18
  // Size the column in DISPLAY CELLS, not code points: a CJK label (default zh)
  // renders 2 cells per glyph, so `.length` (code points) sized the box at ~half
  // the needed width and clipped the label. `approxCellWidth` (the CJK-aware
  // helper the hover tooltip already uses) counts fullwidth codepoints as 2.
  const labelColWidth = () => Math.min(LABEL_COL_MAX, Math.max(...hints().map((h) => approxCellWidth(h.label))))
  // Truncate to the CELL budget too. truncateEnd's budget is code points, so a
  // CJK label needs a code-point budget of at most floor(cells/2) to fit the
  // cell-sized box; take the tighter of the two so a wide label can't overflow.
  const clipLabel = (s: string): string => {
    const cells = labelColWidth()
    if (approxCellWidth(s) <= cells) return s
    const points = [...s]
    let used = 0
    let cut = 0
    for (const ch of points) {
      const w = (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1
      if (used + w > cells - 1) break // reserve 1 cell for the ellipsis
      used += w
      cut++
    }
    return `${points.slice(0, cut).join("")}…`
  }
  // Version + update moved UP to the Sidebar's `kobe` brand header (the old
  // `── system ──` block lived here); the footer is now just the key legend.
  // Move-mode overrides the fold: its two hints are the only exit
  // instructions for reorder mode, so they always render.
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
      {/* Header doubles as the toggle: `?` chord or a click folds/unfolds.
          The `?▸ / ?▾` tail advertises both the chord and the state. */}
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
            // Dim a cap whose action early-returns on a `main` row (`B`/`M`):
            // muted + DIM instead of bold accent, so the user sees it doesn't
            // apply to the project row rather than pressing it into silence.
            const dim = () => h.dimWhenMain === true && (props.selectedIsMain?.() ?? false)
            return (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                {/* `[key]` keycap chip — agent-deck style, mirrors the outer
                monitor's StatusBar Hotkey: bold accent key in brackets,
                muted label. No fill, so it stays clean in transparent mode. */}
                <box width={10} flexShrink={0}>
                  <text
                    fg={dim() ? theme.textMuted : theme.accent}
                    attributes={dim() ? TextAttributes.DIM : TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    [{formatChord(h.k, prefixCap())}]
                  </text>
                </box>
                {/* Description column — fixed width = longest label, pushed to the
                right edge by space-between. Text is left-aligned inside, so
                every description shares one left edge while the whole column
                hugs the right side and rides the pane width. */}
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
