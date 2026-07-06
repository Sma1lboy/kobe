import type { RGBA } from "@opentui/core"
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

type LeafCommand = readonly string[] | null

const splitsByTab = new Map<string, SplitState<LeafCommand>>()

export function releaseSplitLeaves(tabKey: string): void {
  const state = splitsByTab.get(tabKey)
  if (!state) return
  splitsByTab.delete(tabKey)
  for (const leaf of leaves(state.root)) {
    if (leaf.id !== "leaf-1") getDefaultPtyRegistry().release(splitLeafPtyKey(tabKey, leaf.id))
  }
}

export function TerminalSplit(props: {
  tabKey: string
  cwd: () => string
  command: readonly string[]
  onExit?: () => void
  resetToken?: Accessor<number>
  focused: () => boolean
}): JSXElement {
  const { theme } = useTheme()
  const [state, setState] = createSignal<SplitState<LeafCommand>>(splitsByTab.get(props.tabKey) ?? initialSplit(null))
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

  useBindings(() => ({
    enabled: props.focused() && isSplit(),
    bindings: bindByIds({
      "workspace.split.close": () => removeAndRelease(state().activeLeafId),
    }),
  }))

  const leafFocused = (id: string) => props.focused() && state().activeLeafId === id

  const dividerProps = (divider: "left" | "top" | undefined, color: () => RGBA) =>
    divider ? { border: [divider] as ("left" | "top")[], borderColor: color() } : { border: false as const }

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
      />
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
