/** @jsxImportSource @opentui/react */
/**
 * TERMINAL adapter over the content-agnostic split tree (`tui/workspace/
 * split-core.ts`, reused unchanged) — React port of `tui/workspace/
 * TerminalSplit.tsx` (issue #16 React migration). The body of one
 * workspace terminal tab. Leaf content is `readonly string[] | null`: null
 * means "the tab's own command" (only ever `leaf-1`, whose PTY key IS the
 * tab key — `splitLeafPtyKey`), an argv means a split-created shell.
 *
 * `ctrl+\` splits right, `ctrl+=` splits down (new leaves run the user's
 * shell in the same worktree), `f3` cycles leaf focus, and a leaf whose
 * process exits removes itself tmux-style (its group collapses). When the
 * LAST leaf exits, the tab-level `onExit` fires — the caller keeps owning
 * the engine-degrade / close-tab decision.
 *
 * Split state lives ON the tab (`TerminalTab.splitTree`, owned by
 * `TerminalTabs.tsx` and persisted to state.json), passed down as the
 * `splitTree` prop and mutated back through `onSplitChange`.
 *
 * Solid→React deltas: `splitTree`/`cwd`/`focused`/`resetToken`/`engineTitle`
 * are plain values, not Accessors — the parent re-renders on change.
 * `activeLeaf` (local ephemeral focus, kept OUT of the persisted tree —
 * see the Solid header) is `useState`, re-seeded via a `useEffect` keyed on
 * `props.splitTree` identity (the Solid `createEffect(on(...))` twin). The
 * corner name-tag's live-title tracking is the same lazy-attach-with-retry
 * shape as `use-turn-polls.ts`, scoped to this component instead of a
 * shared hook (it only ever serves split shell leaves, one tab at a time).
 * `dividerProps` takes a resolved color value instead of a lazy accessor —
 * React re-evaluates the whole render on any prop/state change, so there is
 * no separate reactive-attribute path to preserve. The opentui borderColor
 * structural-absence trick (divider-less boxes must omit `borderColor`
 * entirely, not pass `undefined` — opentui's Box coerces `border: false` to
 * a full frame whenever any border styling lands) is preserved verbatim.
 */

import { type RGBA, TextAttributes } from "@opentui/core"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { titleDisplayName } from "../../engine/registry"
import { defaultShell } from "../../tui/panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import {
  type SplitLeaf,
  type SplitNode,
  type SplitState,
  cycleLeaf,
  initialSplit,
  leaves,
  removeLeaf,
  renameLeaf,
  splitActive,
} from "../../tui/workspace/split-core"
import { type PersistedSplit, splitLeafNames, splitLeafPtyKey } from "../../tui/workspace/terminal-tabs-core"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { bindByIds } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { Terminal } from "../panes/terminal/Terminal"
import { useDialog } from "../ui/dialog"

/** What a terminal leaf shows: null = the tab's own command (`leaf-1`). */
type LeafCommand = readonly string[] | null

/** The unsplit sentinel — a stable single-leaf tree so a `null` splitTree
 *  renders the fast path without minting a fresh object per read. */
const UNSPLIT: PersistedSplit = initialSplit(null)

/**
 * Release every split-created leaf PTY of `tabKey` — the tab-close
 * counterpart of `TerminalTabs.tsx`'s own `release(tabPtyKey(...))` (which
 * only covers `leaf-1`). Takes the tree explicitly (it lives on the
 * persisted tab, not a module map); null/unsplit trees release nothing.
 */
export function releaseSplitLeaves(tabKey: string, tree: PersistedSplit | null): void {
  if (!tree) return
  for (const leaf of leaves(tree.root)) {
    if (leaf.id !== "leaf-1") getDefaultPtyRegistry().release(splitLeafPtyKey(tabKey, leaf.id))
  }
}

/** Live foreground-process titles for split-created SHELL leaves — retry cadence. */
const TITLE_ATTACH_MS = 2000

/** Split-pulse cadence: a just-created leaf blinks its divider in the
 *  focus accent (accent↔border, two blinks, ~0.5s) then settles. Chrome-
 *  only by design — the split GEOMETRY never animates: every intermediate
 *  width would SIGWINCH the child into a reflow storm. */
const PULSE_TICK_MS = 130
const PULSE_TICKS = 4

export function TerminalSplit(props: {
  /** `tabPtyKey(taskId, tabId)` — PTY registry prefix for this tab's leaves. */
  tabKey: string
  cwd: string
  /** What the tab's ORIGINAL leaf (`leaf-1`) runs — engine or command. */
  command: readonly string[]
  /** The active tab's frozen split layout (null = unsplit). Owned by the
   *  parent, persisted to state.json; switching tabs swaps this prop. */
  splitTree: PersistedSplit | null
  /** Persist a changed layout (null clears back to the unsplit fast path). */
  onSplitChange: (next: PersistedSplit | null) => void
  /** Tab-level exit behavior; fires only when the LAST leaf exits. */
  onExit?: () => void
  /** Forwarded to `leaf-1`'s Terminal — the shell-degrade reacquire nudge. */
  resetToken?: number
  focused: boolean
  /** Ask the host to focus the workspace pane (terminal click). */
  onRequestFocus?: () => void
  /** The tab's first-prompt title (title ?? autoTitle) — the engine leaf's
   *  name, matching the group/tab label. Null before the first prompt. */
  engineTitle?: string | null
}): ReactNode {
  const { theme } = useTheme()
  const t = useT()
  const state = props.splitTree ?? UNSPLIT

  // FOCUS (local, ephemeral): which leaf has focus. Kept OUT of the
  // persisted tree on purpose (see the Solid header's no-whole-tree-
  // reflow rationale). Seeded from the persisted `activeLeafId` and
  // re-seeded whenever the persisted tree changes identity (tab switch
  // or a structural edit).
  const [activeLeaf, setActiveLeaf] = useState<string>(state.activeLeafId)
  useEffect(() => {
    setActiveLeaf((props.splitTree ?? UNSPLIT).activeLeafId)
    // Re-seed only on a genuine tree-identity change (tab switch / structural
    // edit), not on every render.
  }, [props.splitTree])

  /** Full SplitState for the structural transitions that read the active
   *  leaf (split / remove / cycle operate relative to it). */
  const fullState = (): PersistedSplit => ({ ...state, activeLeafId: activeLeaf })

  // Persist a STRUCTURAL change through the parent; clearing to a single
  // leaf drops the tree so an unsplit tab returns to the fast path. Focus
  // changes do NOT come here — they use `setActiveLeaf` (local).
  const update = (next: SplitState<LeafCommand>): void => {
    if (next === state) return
    const ls = leaves(next.root)
    // Collapse to the unsplit fast path (null) ONLY when the sole survivor
    // is leaf-1 — the tab's own engine at `tabKey`. A sole surviving SHELL
    // leaf (you closed the engine leaf) must KEEP the tree so the tree
    // renderer shows the shell at `tabKey::leaf-N`; the fast path would
    // respawn the engine (`props.command` at `tabKey`) instead.
    const collapsesToEngine = ls.length === 1 && ls[0]?.id === "leaf-1"
    props.onSplitChange(collapsesToEngine ? null : next)
  }

  const isSplit = leaves(state.root).length > 1
  // Render via the split tree (not the single-engine fast path) whenever
  // there are multiple leaves OR a single NON-leaf-1 leaf survives (engine
  // closed, shell kept). Only the pristine leaf-1 engine uses the fast path.
  const stateLeaves = leaves(state.root)
  const renderViaTree = stateLeaves.length > 1 || stateLeaves[0]?.id !== "leaf-1"

  /** Remove `id` from the tree and kill its PTY. False when `id` is the
   *  last leaf (nothing removed). State first (the re-render detaches the
   *  leaf's subscribers), then release — same ordering as TerminalTabs'
   *  degrade path. */
  function removeAndRelease(id: string): boolean {
    const cur = fullState()
    const next = removeLeaf(cur, id)
    if (next === null) return false
    if (next !== cur) {
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
    releaseSplitLeaves(props.tabKey, state)
    props.onSplitChange(null)
    props.onExit?.()
  }

  useBindings(() => ({
    enabled: props.focused,
    bindings: bindByIds({
      "workspace.split.right": () => update(splitActive(fullState(), "row", [defaultShell()])),
      "workspace.split.down": () => update(splitActive(fullState(), "column", [defaultShell()])),
      // Focus cycle is LOCAL — no persist, no whole-tree re-render.
      "workspace.split.focus-next": () => setActiveLeaf(cycleLeaf(fullState(), 1).activeLeafId),
    }),
  }))

  // ctrl+w closes / F2 renames the ACTIVE LEAF while split — the
  // innermost thing, same convention as VS Code/iTerm/Warp (and tmux
  // `prefix x`). Gated on isSplit: when the tab is unsplit these entries
  // are disabled and the chords fall through the LIFO stack to
  // TerminalTabs' close-tab / rename-tab bindings.
  const dialog = useDialog()
  useBindings(() => ({
    enabled: props.focused && isSplit,
    bindings: bindByIds({
      "workspace.split.close": () => removeAndRelease(activeLeaf),
      "workspace.split.rename": () => {
        const id = activeLeaf
        void RenameTaskDialog.show(dialog, leafNames.get(id) ?? "", {
          dialogTitle: t("terminal.split.renameTitle"),
          fieldLabel: t("terminal.split.renameField"),
          submitLabel: t("terminal.tab.renameSubmit"),
          allowEmpty: true,
        }).then((title) => {
          if (title === undefined) return
          update(renameLeaf(fullState(), id, title))
        })
      },
    }),
  }))

  const leafFocused = (id: string) => props.focused && activeLeaf === id

  /* Split-pulse (owner request 2026-07-08): announce a NEW leaf by
   * blinking its divider. Leaf-id diff is guarded by tabKey — switching
   * tabs swaps the splitTree prop on this same component instance, and
   * the other tab's leaves must not read as "new". First sight of a tab
   * (including mount) primes silently. */
  const prevLeafIdsRef = useRef<{ key: string; ids: ReadonlySet<string> } | null>(null)
  const [pulse, setPulse] = useState<{ ids: ReadonlySet<string>; tick: number } | null>(null)
  useEffect(() => {
    const ids: ReadonlySet<string> = new Set(leaves(state.root).map((l) => l.id))
    const prev = prevLeafIdsRef.current
    prevLeafIdsRef.current = { key: props.tabKey, ids }
    if (!prev || prev.key !== props.tabKey) return
    const fresh = [...ids].filter((id) => !prev.ids.has(id))
    if (fresh.length > 0) setPulse({ ids: new Set(fresh), tick: 0 })
  }, [props.tabKey, state])
  useEffect(() => {
    if (!pulse) return
    if (pulse.tick >= PULSE_TICKS) {
      setPulse(null)
      return
    }
    const timer = setTimeout(() => setPulse((p) => (p ? { ...p, tick: p.tick + 1 } : null)), PULSE_TICK_MS)
    return () => clearTimeout(timer)
  }, [pulse])

  /** Divider color for a leaf: pulse overrides (even ticks = accent) while
   *  it runs, then the steady focused/unfocused pair. */
  const leafDividerColor = (id: string, focused: boolean): RGBA => {
    if (pulse?.ids.has(id)) return pulse.tick % 2 === 0 ? theme.focusAccent : theme.border
    return focused ? theme.focusAccent : theme.border
  }

  // Live foreground-process titles for split-created SHELL leaves (real
  // terminals track this via the OSC 0/2 window-title escape: "zsh" idle,
  // "vim"/"htop" once you run one — see `TaskPtyLike.onTitleChange`).
  // Engine leaves keep their own conversation-title naming (`engineTitle`),
  // untouched here. Lazy-attach + retry: a leaf's PTY spawns asynchronously
  // after its Terminal mounts, same contract as `use-turn-polls.ts`'s poll
  // attach. Ephemeral (not persisted) — a fresh mount re-derives it as soon
  // as the shell's next title escape lands.
  const [liveTitles, setLiveTitles] = useState<ReadonlyMap<string, string>>(new Map())
  const titleSubsRef = useRef(new Map<string, () => void>())
  const [titleTick, setTitleTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTitleTick((n) => n + 1), TITLE_ATTACH_MS)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    void titleTick
    const reg = getDefaultPtyRegistry()
    const titleSubs = titleSubsRef.current
    const shellLeafIds = new Set(
      leaves(state.root)
        .filter((l) => l.content !== null)
        .map((l) => l.id),
    )
    for (const id of shellLeafIds) {
      if (titleSubs.has(id)) continue
      const pty = reg.get(splitLeafPtyKey(props.tabKey, id))
      if (!pty) continue
      // Normalize through the registry so an engine's decorated title
      // ("✳ Claude Code") reads as its binary ("claude") — one vocabulary
      // across corner tags and tab labels, however the process started.
      titleSubs.set(
        id,
        pty.onTitleChange((title) => setLiveTitles((prev) => new Map(prev).set(id, titleDisplayName(title)))),
      )
    }
    for (const [id, dispose] of titleSubs) {
      if (shellLeafIds.has(id)) continue
      dispose()
      titleSubs.delete(id)
      setLiveTitles((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }
  }, [props.tabKey, state, titleTick])
  useEffect(() => {
    const subs = titleSubsRef.current
    return () => {
      for (const dispose of subs.values()) dispose()
    }
  }, [])

  /** id → display name. Owner correction 2026-07-06: the TAB is the
   *  "group" (its default title says so) — each leaf carries its OWN
   *  name: F2 rename wins, default = basename of what it runs
   *  ("claude", "zsh", "zsh 2"…). Derivation is pure (`splitLeafNames`). */
  const leafNames = splitLeafNames(leaves(state.root), props.command, props.engineTitle, liveTitles)

  /* Dividers, not frames: a node draws ONLY the single edge it shares with
   * its previous sibling (`left` in a row, `top` in a column) — tmux's
   * separator-line look, zero padding, no outer wrapping. The divider a
   * focused LEAF owns lights up in the focus accent. */

  // NOTE: `borderColor` must be ABSENT (not undefined) on divider-less
  // boxes — opentui's Box coerces `border: false` to `true` (a full
  // frame) whenever any border styling lands, both in the constructor
  // and in the `borderColor` setter, and the setter fires even for
  // undefined because parseColor mints a fresh RGBA every call. Hence the
  // conditional spread. This coercion is what drew the phantom frames
  // around the first leaf and the group.
  const dividerProps = (divider: "left" | "top" | undefined, color: RGBA) =>
    divider ? { border: [divider] as ("left" | "top")[], borderColor: color } : { border: false as const }

  const renderLeaf = (leaf: SplitLeaf<LeafCommand>, divider?: "left" | "top"): ReactNode => {
    const focusThis = (): void => setActiveLeaf(leaf.id)
    const focused = leafFocused(leaf.id)
    const body = (
      <>
        <Terminal
          cwd={props.cwd}
          taskId={splitLeafPtyKey(props.tabKey, leaf.id)}
          command={leaf.content ?? props.command}
          onExit={() => onLeafExit(leaf.id)}
          resetToken={leaf.id === "leaf-1" ? props.resetToken : undefined}
          focused={focused}
          onRequestFocus={() => {
            props.onRequestFocus?.()
            focusThis()
          }}
        />
        {/* Corner name tag — ONLY while there's more than one leaf to tell
            apart (see the Solid header: a solo survivor already shows this
            name on the tab strip). */}
        {isSplit ? (
          <box position="absolute" right={0} top={0} zIndex={10} backgroundColor={theme.backgroundElement}>
            <text
              fg={focused ? theme.focusAccent : theme.textMuted}
              attributes={focused ? TextAttributes.BOLD : TextAttributes.DIM}
              wrapMode="none"
            >
              {` ${leafNames.get(leaf.id) ?? ""} `}
            </text>
          </box>
        ) : null}
      </>
    )
    return divider ? (
      <box
        key={leaf.id}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        border={[divider]}
        borderColor={leafDividerColor(leaf.id, focused)}
        onMouseUp={focusThis}
      >
        {body}
      </box>
    ) : (
      <box key={leaf.id} flexGrow={1} flexShrink={1} flexBasis={0} border={false} onMouseUp={focusThis}>
        {body}
      </box>
    )
  }

  // `groupKey` is this node's key AT ITS PARENT (siblings only need
  // uniqueness among themselves — React keys are not global). Leaves key
  // off their stable id; a nested group has none, so its sibling INDEX
  // stands in (stable unless the structure itself changes, which already
  // remounts the subtree by design — split-core transitions return whole
  // new trees, never reorder in place).
  const renderNode = (node: SplitNode<LeafCommand>, groupKey: string, divider?: "left" | "top"): ReactNode =>
    node.kind === "leaf" ? (
      renderLeaf(node, divider)
    ) : (
      <box
        key={groupKey}
        flexDirection={node.orientation}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        {...dividerProps(divider, theme.border)}
      >
        {node.children.map((child, i) =>
          renderNode(
            child,
            child.kind === "leaf" ? child.id : `${groupKey}.${i}`,
            i > 0 ? (node.orientation === "row" ? "left" : "top") : undefined,
          ),
        )}
      </box>
    )

  if (renderViaTree) {
    return (
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {renderNode(state.root, "root")}
      </box>
    )
  }
  // Unsplit fast path: one long-lived borderless Terminal, props swapped
  // in place on tab switch (never remounted while tabs stay unsplit) —
  // leaf-1's key IS the tab key.
  return (
    <Terminal
      cwd={props.cwd}
      taskId={props.tabKey}
      command={props.command}
      onExit={props.onExit}
      resetToken={props.resetToken}
      focused={props.focused}
      onRequestFocus={props.onRequestFocus}
    />
  )
}
