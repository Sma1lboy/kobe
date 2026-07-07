/**
 * TERMINAL adapter over the content-agnostic split tree (`split-core.ts`)
 * — the body of one workspace terminal tab (issue #16). Leaf content is
 * `readonly string[] | null`: null means "the tab's own command" (only
 * ever `leaf-1`, whose PTY key IS the tab key — `splitLeafPtyKey`), an
 * argv means a split-created shell. Other leaf content types (non-
 * terminal surfaces) get their own adapters later; the tree, chords,
 * and binding ids (`workspace.split.*`) are already content-neutral.
 *
 * `ctrl+\` splits right, `ctrl+=` splits down (new leaves run the
 * user's shell in the same worktree), `f3` cycles leaf focus, and a
 * leaf whose process exits removes itself tmux-style (its group
 * collapses). When the LAST leaf exits, the tab-level `onExit` fires —
 * the caller keeps owning the engine-degrade / close-tab decision.
 *
 * Split state lives ON the tab (`TerminalTab.splitTree`, owned by
 * `TerminalTabs.tsx` and persisted to state.json), passed down as the
 * `splitTree` prop and mutated back through `onSplitChange`. That single
 * source of truth means switching tabs restores each tab's layout AND the
 * layout survives restart (owner ask 2026-07-06): on reopen `leaf-1`
 * resumes the tab's engine via its sessionId, the other leaves respawn
 * their shells fresh (the LAYOUT is frozen — a shell the user ran `claude`
 * in comes back as a shell, we don't track the inner session). Leaf PTYs
 * survive in-session via the registry's acquire-reuse.
 *
 * Render fast path: while a tab is UNSPLIT (the overwhelmingly common
 * case) the body is one long-lived `<Terminal>` whose props swap on tab
 * switch — preserving bcc59e90's no-remount-per-switch fix. The tree
 * renderer (which does remount leaves on layout changes) only takes
 * over once a split exists.
 */

import { type RGBA, TextAttributes } from "@opentui/core"
import { type Accessor, For, type JSXElement, Show } from "solid-js"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { bindByIds } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import { Terminal } from "../panes/terminal/Terminal"
import { defaultShell } from "../panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { useDialog } from "../ui/dialog"
import {
  type SplitLeaf,
  type SplitNode,
  type SplitState,
  cycleLeaf,
  focusLeaf,
  initialSplit,
  leaves,
  removeLeaf,
  renameLeaf,
  splitActive,
} from "./split-core"
import { type PersistedSplit, splitLeafNames, splitLeafPtyKey } from "./terminal-tabs-core"

/** What a terminal leaf shows: null = the tab's own command (`leaf-1`). */
type LeafCommand = readonly string[] | null

/** The unsplit sentinel — a stable single-leaf tree so a `null` splitTree
 *  renders the fast path without minting a fresh object per read. */
const UNSPLIT: PersistedSplit = initialSplit(null)

/**
 * Release every split-created leaf PTY of `tabKey` — the tab-close
 * counterpart of `TerminalTabs.tsx`'s own `release(tabPtyKey(...))`
 * (which only covers `leaf-1`). Without this, closing a split tab leaked
 * every extra leaf's shell until task archive. Takes the tree explicitly
 * (it lives on the persisted tab now, not a module map); null/unsplit
 * trees release nothing.
 */
export function releaseSplitLeaves(tabKey: string, tree: PersistedSplit | null): void {
  if (!tree) return
  for (const leaf of leaves(tree.root)) {
    if (leaf.id !== "leaf-1") getDefaultPtyRegistry().release(splitLeafPtyKey(tabKey, leaf.id))
  }
}

export function TerminalSplit(props: {
  /** `tabPtyKey(taskId, tabId)` — PTY registry prefix for this tab's leaves. */
  tabKey: string
  cwd: () => string
  /** What the tab's ORIGINAL leaf (`leaf-1`) runs — engine or command. */
  command: readonly string[]
  /**
   * The active tab's frozen split layout (null = unsplit). Owned by the
   * parent (`TerminalTabs` stores it on the tab, persisted to state.json),
   * so switching tabs swaps this prop and the layout follows — no local
   * per-tab map, and the layout survives restart for free.
   */
  splitTree: () => PersistedSplit | null
  /** Persist a changed layout (null clears back to the unsplit fast path). */
  onSplitChange: (next: PersistedSplit | null) => void
  /** Tab-level exit behavior; fires only when the LAST leaf exits. */
  onExit?: () => void
  /** Forwarded to `leaf-1`'s Terminal — the shell-degrade reacquire nudge. */
  resetToken?: Accessor<number>
  focused: () => boolean
  /** Ask the host to focus the workspace pane (terminal click). */
  onRequestFocus?: () => void
}): JSXElement {
  const { theme } = useTheme()
  // Derived, not a local signal: the layout lives on the tab (parent),
  // so a tab switch (props.splitTree changes) restores that tab's layout
  // reactively — bcc59e90's no-remount body still swaps props in place.
  const state = (): PersistedSplit => props.splitTree() ?? UNSPLIT
  // Persist through the parent; clearing to a single leaf drops the tree
  // so an unsplit tab returns to the fast path (and stops persisting one).
  const update = (next: SplitState<LeafCommand>): void => {
    props.onSplitChange(leaves(next.root).length > 1 ? next : null)
  }

  const isSplit = () => leaves(state().root).length > 1

  /** Remove `id` from the tree and kill its PTY. False when `id` is the
   *  last leaf (nothing removed). State first (the re-render detaches the
   *  leaf's subscribers), then release — same ordering as TerminalTabs'
   *  degrade path. */
  function removeAndRelease(id: string): boolean {
    const next = removeLeaf(state(), id)
    if (next === null) return false
    if (next !== state()) {
      update(next)
      getDefaultPtyRegistry().release(splitLeafPtyKey(props.tabKey, id))
    }
    return true
  }

  function onLeafExit(id: string): void {
    if (removeAndRelease(id)) return
    // Last leaf — release any dead non-leaf-1 registry entry the tree
    // still names, clear the layout (back to the unsplit fast path), and
    // hand the exit to the tab's own behavior (engine → degrade to shell,
    // command tab → close).
    releaseSplitLeaves(props.tabKey, state())
    props.onSplitChange(null)
    props.onExit?.()
  }

  useBindings(() => ({
    enabled: props.focused(),
    bindings: bindByIds({
      "workspace.split.right": () => update(splitActive(state(), "row", [defaultShell()])),
      "workspace.split.down": () => update(splitActive(state(), "column", [defaultShell()])),
      "workspace.split.focus-next": () => update(cycleLeaf(state(), 1)),
    }),
  }))

  // ctrl+w closes / F2 renames the ACTIVE LEAF while split — the
  // innermost thing, same convention as VS Code/iTerm/Warp (and tmux
  // `prefix x`). Gated on isSplit(): when the tab is unsplit these
  // entries are disabled and the chords fall through the LIFO stack to
  // TerminalTabs' close-tab / rename-tab bindings. Registered after the
  // parent's bindings (child mounts later), so they win when enabled.
  const dialog = useDialog()
  useBindings(() => ({
    enabled: props.focused() && isSplit(),
    bindings: bindByIds({
      "workspace.split.close": () => removeAndRelease(state().activeLeafId),
      "workspace.split.rename": () => {
        const id = state().activeLeafId
        void RenameTaskDialog.show(dialog, leafNames().get(id) ?? "", {
          dialogTitle: t("terminal.split.renameTitle"),
          fieldLabel: t("terminal.split.renameField"),
          submitLabel: t("terminal.tab.renameSubmit"),
          allowEmpty: true,
        }).then((title) => {
          if (title === undefined) return
          update(renameLeaf(state(), id, title))
        })
      },
    }),
  }))

  const leafFocused = (id: string) => props.focused() && state().activeLeafId === id

  /* Dividers, not frames: a node draws ONLY
   * the single edge it shares with its previous sibling (`left` in a row,
   * `top` in a column) — tmux's separator-line look, zero padding, no
   * outer wrapping. The divider a focused LEAF owns lights up in the
   * focus accent (the first leaf owns none; its cursor is the signal). */

  // NOTE: `borderColor` must be ABSENT (not undefined) on divider-less
  // boxes — opentui's Box coerces `border: false` to `true` (a full
  // frame) whenever any border styling lands, both in the constructor
  // and in the `borderColor` setter (`initializeBorder`), and the setter
  // fires even for undefined because parseColor mints a fresh RGBA every
  // call. Hence the conditional spread. This coercion is what drew the
  // phantom frames around the first leaf and the group.
  const dividerProps = (divider: "left" | "top" | undefined, color: () => RGBA) =>
    divider ? { border: [divider] as ("left" | "top")[], borderColor: color() } : { border: false as const }

  /** id → display name. Owner correction 2026-07-06: the TAB is the
   *  "group" (its default title says so) — each leaf carries its OWN
   *  name: F2 rename wins, default = basename of what it runs
   *  ("claude", "zsh", "zsh 2"…). Derivation is pure (`splitLeafNames`)
   *  so vitest pins it. */
  const leafNames = () => splitLeafNames(leaves(state().root), props.command)

  const renderLeaf = (leaf: SplitLeaf<LeafCommand>, divider?: "left" | "top"): JSXElement => (
    <box
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      {...dividerProps(divider, () => (leafFocused(leaf.id) ? theme.focusAccent : theme.border))}
      onMouseUp={() => update(focusLeaf(state(), leaf.id))}
    >
      <Terminal
        cwd={props.cwd}
        taskId={() => splitLeafPtyKey(props.tabKey, leaf.id)}
        command={leaf.content ?? props.command}
        onExit={() => onLeafExit(leaf.id)}
        resetToken={leaf.id === "leaf-1" ? props.resetToken : undefined}
        focused={() => leafFocused(leaf.id)}
        onRequestFocus={() => {
          // Click a split leaf → focus the workspace pane globally AND make
          // this the active leaf (the wrapper box's onMouseUp can't, since
          // the Terminal consumes the click before it bubbles).
          props.onRequestFocus?.()
          update(focusLeaf(state(), leaf.id))
        }}
      />
      {/* Corner name tag — the leaf's OWN name (see leafNames above);
          the focused leaf's tag lights in the focus accent; overlays the
          terminal's top-right cell row (tmux-pane-number style, but
          always on since it's the leaf's only label). */}
      <box position="absolute" right={0} top={0} zIndex={10} backgroundColor={theme.backgroundElement}>
        <text
          fg={leafFocused(leaf.id) ? theme.focusAccent : theme.textMuted}
          attributes={leafFocused(leaf.id) ? TextAttributes.BOLD : TextAttributes.DIM}
          wrapMode="none"
        >
          {` ${leafNames().get(leaf.id) ?? ""} `}
        </text>
      </box>
    </box>
  )

  const renderNode = (node: SplitNode<LeafCommand>, divider?: "left" | "top"): JSXElement =>
    node.kind === "leaf" ? (
      renderLeaf(node, divider)
    ) : (
      <box
        flexDirection={node.orientation}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        {...dividerProps(divider, () => theme.border)}
      >
        <For each={node.children}>
          {(child, i) => renderNode(child, i() > 0 ? (node.orientation === "row" ? "left" : "top") : undefined)}
        </For>
      </box>
    )

  return (
    <Show
      when={isSplit()}
      fallback={
        // Unsplit fast path: one long-lived borderless Terminal, props
        // swapped in place on tab switch (never remounted while tabs
        // stay unsplit) — leaf-1's key IS the tab key.
        <Terminal
          cwd={props.cwd}
          taskId={() => props.tabKey}
          command={props.command}
          onExit={props.onExit}
          resetToken={props.resetToken}
          focused={props.focused}
          onRequestFocus={props.onRequestFocus}
        />
      }
    >
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {renderNode(state().root)}
      </box>
    </Show>
  )
}
