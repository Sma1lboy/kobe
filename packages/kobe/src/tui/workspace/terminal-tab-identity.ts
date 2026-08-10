/**
 * Live tab identity — the ONE transition that turns an engine tab back into
 * a shell tab when its engine exits.
 *
 * The model (owner 2026-08-10): every tab IS a shell. An engine is just a
 * process running inside it — `shellSpawn` types the CLI into the user's
 * shell, so exiting claude lands on a normal prompt with the PTY still very
 * much alive. `kind` therefore describes what the tab is running NOW, not
 * what it was born as.
 *
 * Before this, `kind` froze at birth and every consumer had to re-derive
 * "…but is it still an engine?" from the live probe — the sidebar's state
 * dot and the optimistic activity marks simply never did, so a tab you
 * exited claude in kept its dot and lit up `running` on any keystroke while
 * its own label already read `shell N`. `tabTitleStable` shows the shape of
 * the workaround: it builds `{...tab, kind: "command"}` to compute a label
 * for a tab the type system still calls an engine. Resetting the state once,
 * at the exit, is what makes all of those agree without a per-consumer
 * guard.
 *
 * Deliberately NOT the inverse: a shell the user types `claude` into is an
 * agent for glyph/detector purposes (the live probe answers that, and
 * `targetFor` already routes on it), but it has no kobe-pinned session, so
 * promoting its `kind` would claim a resume story that doesn't exist.
 */

import type { VendorId } from "../../types/vendor"
import type { TerminalTab } from "./terminal-tabs-core"

/**
 * The engine in this tab exited: reset it to the shell it always was.
 *
 * Returns the same tab when nothing should change, so callers can assign
 * unconditionally (the identity-stable contract `setTabLiveVendor` and
 * friends follow).
 *
 * `prev`/`live` are the tri-state process identity (`live-engine.ts`) across
 * one probe: demotion fires only on a real vendor → confirmed-null EDGE.
 * Keying on `live === null` alone would demote during the spawn window —
 * the PTY is attached and the shell is up, but the engine it's about to run
 * hasn't appeared in the process tree yet.
 *
 * What's dropped is exactly the engine's own state: the session pin (that
 * conversation is over — a later re-acquire spawns a plain shell, the same
 * thing `rehydrateTabs` does for command tabs), and `lastTitle`, which for a
 * status-owning engine is its self-reported spinner phrase and must not go
 * on naming a shell. The user's manual `title`, the tab's ordinal, split
 * layout, and first-prompt `autoTitle` survive — so the rendered label is
 * byte-identical to what `tabTitleStable` was already computing for this tab.
 */
export function demoteExitedEngine(
  tab: TerminalTab,
  prev: VendorId | null | undefined,
  live: VendorId | null | undefined,
  shell: readonly string[],
): TerminalTab {
  if (tab.kind !== "engine" || live !== null || !prev) return tab
  // A viewport tab (`ptyTask`) only VIEWS another task's session — its key
  // and cwd point at that task, and this workspace doesn't own its lifecycle.
  if (tab.ptyTask) return tab
  return {
    kind: "command",
    command: shell,
    id: tab.id,
    title: tab.title,
    ordinal: tab.ordinal,
    ...(tab.autoTitle !== undefined ? { autoTitle: tab.autoTitle } : {}),
    ...(tab.splitTree !== undefined ? { splitTree: tab.splitTree } : {}),
    lastTitle: null,
    liveVendor: null,
  }
}
