/** @jsxImportSource @opentui/react */
/**
 * Help dialog (React port of `src/tui/component/help-dialog.tsx`, issue
 * #15 G3) — kobe's global keybindings, grouped by category via the shared
 * framework-free `src/tui/lib/help-groups.ts`. Each row prints the
 * canonical chord (macOS glyphs via `formatChord`) plus the description;
 * alternate chords in a lighter color. Pane-local bindings are
 * intentionally not listed — this is the global-bindings registry only.
 * Full rationale (what was dropped in v0.6, why esc isn't re-bound here)
 * lives in the Solid header.
 *
 * React deltas: the keymap table is mutated in place on keybindings.yaml
 * reloads, invisible to React — `useKeymapVersion()` subscribes this
 * component and invalidates the grouped rows; `useT()` subscribes it to
 * language changes so the non-reactive `tKeys` lookups re-run.
 */

import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useMemo, useRef } from "react"
import { formatChord } from "../../tui/lib/chord-glyphs"
import { type HelpGrammarSection, type HelpSurface, grammarHelpSections } from "../../tui/lib/help-groups"
import { type BindingReachability, currentPrefixConfiguration } from "../../tui/lib/keymap-dispatch"
import { KobeKeymap, useKeymapVersion } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { tKeys, useT } from "../i18n"
import { currentBindingReachability, useBindings } from "../lib/keymap"
import { type DialogContext, useDialog } from "../ui/dialog"

function scopeCategory(scope: HelpGrammarSection["scope"]): string {
  if (!scope) return "Global"
  if (scope === "sidebar") return "Sidebar"
  if (scope === "workspace") return "Workspace"
  if (scope === "files") return "Files"
  if (scope === "terminal") return "Terminal"
  return "Dialog"
}

function displayCap(cap: string): string {
  return cap
    .split(" + ")
    .map((part) => formatChord(part))
    .join(" + ")
}

function sectionTitle(section: HelpGrammarSection, t: ReturnType<typeof useT>): string {
  if (section.kind === "here") return t("help.here", { surface: tKeys("category", scopeCategory(section.scope)) })
  if (section.kind === "direct") return t("help.direct")
  if (section.kind === "prefix") return t("help.afterPrefix")
  return t("help.otherPane", { surface: tKeys("category", scopeCategory(section.scope)) })
}

export function HelpDialog(props: {
  onClose?: () => void
  currentScope?: HelpSurface
  reachability?: BindingReachability
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const t = useT()
  const keymapVersion = useKeymapVersion()
  const pureTuiPrefix = currentPrefixConfiguration()
  // biome-ignore lint/correctness/useExhaustiveDependencies: keymapVersion is the invalidation key — the table is mutated in place.
  const sections = useMemo(
    () => grammarHelpSections(KobeKeymap, props.currentScope ?? null, pureTuiPrefix.key, props.reachability),
    [keymapVersion, props.currentScope, props.reachability, pureTuiPrefix.key],
  )
  // Standalone full-window page (`kobe help-page`) passes its own exit;
  // the in-pane overlay closes by clearing the dialog stack.
  const close = () => (props.onClose ? props.onClose() : dialog.clear())

  // Keyboard scrolling for the shortcut reference — native navigation keys
  // only (arrows/page/home/end), no new Kobe-owned chords, so keyboard-only
  // users can read below the fold (docs/KEYBINDINGS.md pane-scope rules).
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const scrollBy = (lines: number): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.scrollTo({ x: 0, y: Math.max(0, scroll.scrollTop + lines) })
  }
  const scrollToEdge = (edge: "top" | "bottom"): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.scrollTo({ x: 0, y: edge === "top" ? 0 : Number.MAX_SAFE_INTEGER })
  }

  // Press `?` again to dismiss. esc
  // is handled by the DialogProvider's own binding stack — don't re-bind.
  useBindings(() => ({
    bindings: [
      { key: "?", cmd: close },
      { key: "up", cmd: () => scrollBy(-1) },
      { key: "down", cmd: () => scrollBy(1) },
      { key: "pageup", cmd: () => scrollBy(-(scrollRef.current?.viewport.height ?? 10)) },
      { key: "pagedown", cmd: () => scrollBy(scrollRef.current?.viewport.height ?? 10) },
      { key: "home", cmd: () => scrollToEdge("top") },
      { key: "end", cmd: () => scrollToEdge("bottom") },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexShrink={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <box flexDirection="column" gap={0}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            {t("help.title")}
          </text>
          <text fg={theme.textMuted}>
            {props.currentScope
              ? t("help.focused", { surface: tKeys("category", scopeCategory(props.currentScope)) })
              : t("help.allBindings")}
          </text>
          <text fg={theme.textMuted}>
            {t("help.grammar", {
              prefix: pureTuiPrefix.key ? formatChord(pureTuiPrefix.key) : t("help.disabled"),
            })}
          </text>
        </box>
        <text fg={theme.textMuted} onMouseUp={close}>
          {t("help.esc")}
        </text>
      </box>
      {/* Long-content dialogs handle their own overflow: flexShrink={1}
          fits the dialog's maxHeight, the scrollbox owns the scrolling. */}
      <scrollbox
        ref={(r: ScrollBoxRenderable | null) => {
          scrollRef.current = r
        }}
        flexShrink={1}
        flexGrow={1}
        stickyScroll={false}
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: theme.backgroundDialog, foregroundColor: theme.borderActive },
        }}
      >
        <box paddingBottom={1} gap={1} paddingRight={1}>
          {sections.map((section, sectionIndex) => (
            <box key={`${section.kind}-${section.scope ?? sectionIndex}`} gap={0}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                {sectionTitle(section, t)}
              </text>
              {section.rows.map((row) => {
                return (
                  <box key={`${section.kind}-${row.binding.id}`} flexDirection="row" gap={2} paddingLeft={1}>
                    <box width={18}>
                      <text fg={theme.primary}>{displayCap(row.primary)}</text>
                    </box>
                    <box flexGrow={1}>
                      <text fg={theme.text}>{tKeys("desc", row.binding.id)}</text>
                    </box>
                    {row.aliases.length > 0 ? (
                      <box>
                        <text fg={theme.textMuted}>{`(${row.aliases.map(displayCap).join(", ")})`}</text>
                      </box>
                    ) : null}
                  </box>
                )
              })}
            </box>
          ))}
        </box>
      </scrollbox>
    </box>
  )
}

/**
 * Convenience opener — pushes the help dialog onto the dialog stack.
 * Used by the global `?` binding. Static for parity with the Solid original.
 */
HelpDialog.show = (dialog: DialogContext, currentScope?: HelpSurface): void => {
  const reachability = currentBindingReachability()
  const inputScope = reachability.inputPassthrough ? "terminal" : currentScope
  dialog.replace(() => <HelpDialog currentScope={inputScope} reachability={reachability} />)
}
