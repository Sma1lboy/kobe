/**
 * Split-pane body of ONE workspace terminal tab (issue #16) — the
 * PTY-world take on tmux panes, rendering `terminal-split-core.ts`'s
 * tree. `ctrl+\` splits right, `ctrl+=` splits down (new panes run the
 * user's shell in the same worktree), `f3` cycles pane focus, and a
 * pane whose process exits removes itself tmux-style (its group
 * collapses). When the LAST pane exits, the tab-level `onExit` fires —
 * the caller keeps owning the engine-degrade / close-tab decision.
 *
 * Split state lives in a module-level map keyed by the tab's PTY key,
 * mirroring `TerminalTabs.tsx`'s `tabsByTask` pattern, so switching
 * tasks/tabs and back preserves each tab's layout (the pane PTYs
 * already survive via the registry's acquire-reuse).
 */

import { For, type JSXElement, createEffect, createSignal, on } from "solid-js"
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
  paneKey,
  removeLeaf,
  splitActive,
} from "./terminal-split-core"

/** Per-tab split state, preserved across task/tab switches (see header). */
const splitsByTab = new Map<string, SplitState>()

/**
 * Release every split-created pane PTY of `tabKey` and forget its
 * layout — the tab-close counterpart of `TerminalTabs.tsx`'s own
 * `release(tabPtyKey(...))` (which only covers `pane-1`). Without this,
 * closing a split tab leaked every extra pane's shell until task
 * archive.
 */
export function releaseSplitPanes(tabKey: string): void {
  const state = splitsByTab.get(tabKey)
  if (!state) return
  splitsByTab.delete(tabKey)
  for (const leaf of leaves(state.root)) {
    if (leaf.id !== "pane-1") getDefaultPtyRegistry().release(paneKey(tabKey, leaf.id))
  }
}

export function TerminalSplit(props: {
  /** `tabPtyKey(taskId, tabId)` — PTY registry prefix AND layout map key. */
  tabKey: string
  cwd: () => string
  /** What the tab's ORIGINAL pane (`pane-1`) runs — engine or command. */
  command: readonly string[]
  /** Tab-level exit behavior; fires only when the LAST pane exits. */
  onExit?: () => void
  focused: () => boolean
}): JSXElement {
  const { theme } = useTheme()
  const [state, setState] = createSignal<SplitState>(splitsByTab.get(props.tabKey) ?? initialSplit())
  // Track tab switches: the host renders ONE long-lived body and swaps
  // props (bcc59e90 killed the remount-per-switch), so `tabKey` changes
  // in place and the layout must follow it — an init-only read would
  // freeze every tab on the first tab's layout.
  createEffect(
    on(
      () => props.tabKey,
      (key) => setState(splitsByTab.get(key) ?? initialSplit()),
      { defer: true },
    ),
  )
  const update = (next: SplitState): void => {
    splitsByTab.set(props.tabKey, next)
    setState(next)
  }

  /** Borders only appear once the tab is actually split — a single pane
   *  stays borderless exactly as before (the workspace wrapper owns the
   *  pane-level focus border). */
  const splitLayout = () => leaves(state().root).length > 1

  function onLeafExit(id: string): void {
    const next = removeLeaf(state(), id)
    if (next === null) {
      // Last pane — hand the exit to the tab's own behavior
      // (engine → degrade to shell, command tab → close).
      props.onExit?.()
      return
    }
    if (next === state()) return
    // State first (the re-render detaches the dead pane's subscribers),
    // then release — same ordering as TerminalTabs' degrade path.
    update(next)
    getDefaultPtyRegistry().release(paneKey(props.tabKey, id))
  }

  useBindings(() => ({
    enabled: props.focused(),
    bindings: bindByIds({
      "chat.pane.split-right": () => update(splitActive(state(), "row", [defaultShell()])),
      "chat.pane.split-down": () => update(splitActive(state(), "column", [defaultShell()])),
      "chat.pane.focus-next": () => update(cycleLeaf(state(), 1)),
    }),
  }))

  const renderLeaf = (leaf: SplitLeaf): JSXElement => (
    <box
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      border={splitLayout()}
      borderColor={props.focused() && state().activeLeafId === leaf.id ? theme.focusAccent : theme.border}
      onMouseUp={() => update(focusLeaf(state(), leaf.id))}
    >
      <Terminal
        cwd={props.cwd}
        taskId={() => paneKey(props.tabKey, leaf.id)}
        command={leaf.command ?? props.command}
        onExit={() => onLeafExit(leaf.id)}
        focused={() => props.focused() && state().activeLeafId === leaf.id}
      />
    </box>
  )

  const renderNode = (node: SplitNode): JSXElement =>
    node.kind === "leaf" ? (
      renderLeaf(node)
    ) : (
      <box flexDirection={node.orientation} flexGrow={1} flexShrink={1} flexBasis={0}>
        <For each={node.children}>{(child) => renderNode(child)}</For>
      </box>
    )

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      {renderNode(state().root)}
    </box>
  )
}
