/**
 * Split-tree policy for a terminal tab — the terminal-flavored layer over
 * the content-agnostic `split-core.ts` tree, split out of
 * `terminal-tabs-core.ts` (the tab-list transitions) purely for the
 * 500-line file-size cap. Owns the persisted leaf payload shape
 * ({@link PersistedSplit}), the collapse/is-split/has-engine predicates,
 * leaf PTY keying, and leaf display naming. No tab-shape imports: it knows
 * split trees and leaf payloads, never `TabsState`.
 */

import { pathLeaf } from "../lib/path-helpers"
import { type SplitState, leaves } from "./split-core"

/**
 * A tab's frozen split layout — the content-agnostic tree (`split-core`)
 * with terminal-flavored leaf payloads: `null` = the tab's own engine
 * command (only `leaf-1`), an argv = a split-created shell. JSON-safe, so
 * it rides the persisted tab straight into state.json.
 */
export type PersistedSplit = SplitState<readonly string[] | null>

/**
 * Whether a tab still runs its own engine leaf (`leaf-1`) — false once
 * you've closed it inside a split and only split-created shells survive
 * (57e3a20a). Unsplit (no tree) always counts as having it. Callers that
 * treat an engine tab as having live turn activity (the turn-poll loop,
 * the tab-strip's turn chip) must gate on this too, or a closed engine
 * leaf leaves a stale poll flapping against its released PTY.
 */
export function hasEngineLeaf(tree: PersistedSplit | null | undefined): boolean {
  return !tree || leaves(tree.root).some((l) => l.id === "leaf-1")
}

/**
 * Whether a tab's frozen layout is ACTUALLY split (>1 leaf). Gates the
 * ctrl+w / F2 chord fall-through between `TerminalTabs` and
 * `TerminalSplit`: while split, the tab-level close/rename bindings
 * disable so the chords reach the leaf-level ones, and vice versa. A
 * single surviving non-leaf-1 shell is NOT split — tab-level chords apply.
 */
export function isTabSplit(tree: PersistedSplit | null | undefined): boolean {
  return tree ? leaves(tree.root).length > 1 : false
}

/**
 * Collapse rule for a structural split edit: a tree whose SOLE survivor
 * is `leaf-1` (the tab's own engine at the tab key) folds back to `null`
 * — the unsplit fast path. A sole surviving SHELL leaf must KEEP the
 * tree: the fast path would respawn the engine (`props.command` at the
 * tab key) over it. Doubles as the render predicate — a non-null result
 * means the tab renders via the tree, not the single-engine fast path.
 */
export function collapseSplit(next: PersistedSplit): PersistedSplit | null {
  const ls = leaves(next.root)
  return ls.length === 1 && ls[0]?.id === "leaf-1" ? null : next
}

/**
 * Registry key for one split leaf's PTY inside a tab (`TerminalSplit.tsx`
 * over the content-agnostic `split-core.ts`). `leaf-1` maps to the TAB
 * key itself so the PTY that existed before the first split is reused,
 * not respawned; later leaves namespace under it.
 */
export function splitLeafPtyKey(tabKey: string, leafId: string): string {
  return leafId === "leaf-1" ? tabKey : `${tabKey}::${leafId}`
}

/**
 * Display names for a split tab's leaves, id → name (owner semantics
 * 2026-07-06: the TAB is the "group"; each leaf carries its OWN name).
 * Naming flow mirrors tabs: a manual rename (`leaf.title`) always wins.
 *
 * The ENGINE leaf (`null` content = the tab's own command) reads the
 * conversation's first-prompt title (`engineTitle` — the tab's own
 * title/autoTitle, the same string the group/tab label shows), falling back
 * to the command basename ("claude"/"codex") before the first prompt lands.
 * Split SHELL leaves read their live foreground-process title (`liveTitles`
 * — the OSC 0/2 window-title escape the shell/program sets, same mechanism
 * a real terminal tab uses: "zsh" idle, "vim"/"htop" once you run one),
 * falling back to the generic "shell" before any title has landed yet.
 * Same-named defaults get a reading-order occurrence suffix ("shell",
 * "shell 2") so two untitled shells stay tellable apart. Manual titles (F2
 * rename) always win and are never suffixed.
 */
/** Generic default name for a split-created shell leaf (a bare shell has no
 *  meaningful program name). Shared so the corner tag and a collapsed tab's
 *  label agree. */
export const SHELL_LEAF_NAME = "shell"

export function splitLeafNames(
  leafList: readonly { id: string; title?: string | null; content: readonly string[] | null }[],
  tabCommand: readonly string[],
  engineTitle?: string | null,
  liveTitles?: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const basename = (argv: readonly string[] | null): string => {
    const head = (argv ?? tabCommand)[0] ?? ""
    const name = pathLeaf(head)
    return name.length > 0 ? name : "?"
  }
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const leaf of leafList) {
    if (leaf.title) {
      out.set(leaf.id, leaf.title)
      continue
    }
    // Engine leaf → first-prompt title, else its live foreground-process
    // title (a shell tab's leaf-1 runs zsh and can enter claude/vim — the
    // static command basename would freeze on "zsh"), else vendor basename;
    // split shell leaf → live title, else generic "shell". Both dedupe by
    // reading order.
    const name =
      leaf.content === null
        ? engineTitle || liveTitles?.get(leaf.id) || basename(leaf.content)
        : liveTitles?.get(leaf.id) || SHELL_LEAF_NAME
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    out.set(leaf.id, n === 1 ? name : `${name} ${n}`)
  }
  return out
}
