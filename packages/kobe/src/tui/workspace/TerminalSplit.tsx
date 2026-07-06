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
 * Split state lives in a module-level map keyed by the tab's PTY key,
 * mirroring `TerminalTabs.tsx`'s `tabsByTask` pattern, so switching
 * tasks/tabs and back preserves each tab's layout (the leaf PTYs
 * already survive via the registry's acquire-reuse).
 *
 * Render fast path: while a tab is UNSPLIT (the overwhelmingly common
 * case) the body is one long-lived `<Terminal>` whose props swap on tab
 * switch — preserving bcc59e90's no-remount-per-switch fix. The tree
 * renderer (which does remount leaves on layout changes) only takes
 * over once a split exists.
 */

import { type Accessor, For, type JSXElement, Show, createEffect, createSignal, on } from "solid-js"
import { bindByIds } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { useBindings } from "../lib/keymap"
import { Terminal } from "../panes/terminal/Terminal"
import { defaultShell } from "../panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import {
  type SplitLeaf,
  type SplitNode,
  type SplitState,
  cycleLeaf,
  focusLeaf,
  initialSplit,
  leaves,
  removeLeaf,
  splitActive,
} from "./split-core"
import { splitLeafPtyKey } from "./terminal-tabs-core"

/** What a terminal leaf shows: null = the tab's own command (`leaf-1`). */
type LeafCommand = readonly string[] | null

/** Per-tab split state, preserved across task/tab switches (see header). */
const splitsByTab = new Map<string, SplitState<LeafCommand>>()

/**
 * Release every split-created leaf PTY of `tabKey` and forget its
 * layout — the tab-close counterpart of `TerminalTabs.tsx`'s own
 * `release(tabPtyKey(...))` (which only covers `leaf-1`). Without this,
 * closing a split tab leaked every extra leaf's shell until task
 * archive.
 */
export function releaseSplitLeaves(tabKey: string): void {
  const state = splitsByTab.get(tabKey)
  if (!state) return
  splitsByTab.delete(tabKey)
  for (const leaf of leaves(state.root)) {
    if (leaf.id !== "leaf-1") getDefaultPtyRegistry().release(splitLeafPtyKey(tabKey, leaf.id))
  }
}

export function TerminalSplit(props: {
  /** `tabPtyKey(taskId, tabId)` — PTY registry prefix AND layout map key. */
  tabKey: string
  cwd: () => string
  /** What the tab's ORIGINAL leaf (`leaf-1`) runs — engine or command. */
  command: readonly string[]
  /** Tab-level exit behavior; fires only when the LAST leaf exits. */
  onExit?: () => void
  /** Forwarded to `leaf-1`'s Terminal — the shell-degrade reacquire nudge. */
  resetToken?: Accessor<number>
  focused: () => boolean
}): JSXElement {
  const { theme } = useTheme()
  const [state, setState] = createSignal<SplitState<LeafCommand>>(splitsByTab.get(props.tabKey) ?? initialSplit(null))
  // Track tab switches: the host renders ONE long-lived body and swaps
  // props (bcc59e90 killed the remount-per-switch), so `tabKey` changes
  // in place and the layout must follow it — an init-only read would
  // freeze every tab on the first tab's layout.
  createEffect(
    on(
      () => props.tabKey,
      (key) => setState(splitsByTab.get(key) ?? initialSplit(null)),
      { defer: true },
    ),
  )
  const update = (next: SplitState<LeafCommand>): void => {
    splitsByTab.set(props.tabKey, next)
    setState(next)
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
    // Last leaf — reset the layout (releasing any dead non-leaf-1
    // registry entry it still names) and hand the exit to the tab's
    // own behavior (engine → degrade to shell, command tab → close).
    releaseSplitLeaves(props.tabKey)
    setState(initialSplit(null))
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

  // ctrl+w closes the ACTIVE LEAF while split — the innermost thing, same
  // convention as VS Code/iTerm/Warp (and tmux `prefix x`). Gated on
  // isSplit(): when the tab is unsplit this entry is disabled and the
  // chord falls through the LIFO stack to TerminalTabs' close-tab
  // binding. Registered after the parent's bindings (child mounts later),
  // so it wins the stack whenever enabled.
  useBindings(() => ({
    enabled: props.focused() && isSplit(),
    bindings: bindByIds({
      "workspace.split.close": () => removeAndRelease(state().activeLeafId),
    }),
  }))

  const leafFocused = (id: string) => props.focused() && state().activeLeafId === id

  const renderLeaf = (leaf: SplitLeaf<LeafCommand>): JSXElement => (
    <box
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      border={true}
      borderColor={leafFocused(leaf.id) ? theme.focusAccent : theme.border}
      onMouseUp={() => update(focusLeaf(state(), leaf.id))}
    >
      <Terminal
        cwd={props.cwd}
        taskId={() => splitLeafPtyKey(props.tabKey, leaf.id)}
        command={leaf.content ?? props.command}
        onExit={() => onLeafExit(leaf.id)}
        resetToken={leaf.id === "leaf-1" ? props.resetToken : undefined}
        focused={() => leafFocused(leaf.id)}
      />
    </box>
  )

  const renderNode = (node: SplitNode<LeafCommand>): JSXElement =>
    node.kind === "leaf" ? (
      renderLeaf(node)
    ) : (
      <box flexDirection={node.orientation} flexGrow={1} flexShrink={1} flexBasis={0}>
        <For each={node.children}>{(child) => renderNode(child)}</For>
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
        />
      }
    >
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {renderNode(state().root)}
      </box>
    </Show>
  )
}
