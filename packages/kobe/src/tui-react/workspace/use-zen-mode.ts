/**
 * Zen mode state for the PureTUI workspace (issue #18): the layout collapses
 * to the engine pane, hiding files and terminal (and the Tasks rail too, when
 * `zen.keepTasks` is off).
 *
 * The on/off intent is persisted under `zen.active`, so the workspace comes
 * back in the layout it left in — Settings → General → "Start in zen mode"
 * edits the same key, which makes that row both the startup default and a
 * mirror of the live state.
 *
 * Read/written through the KV context rather than `state/zen.ts`'s helpers so
 * this shares the Settings dialog's cache; the two layers write the same
 * state.json but would disagree until a reload if they cached separately.
 */

import { useEffect, useState } from "react"
import { ZEN_ACTIVE_KEY } from "../../state/zen.ts"
import type { FocusContextValue } from "../context/focus"
import type { KVContext } from "../context/kv"

export type ZenMode = {
  /** Whether the workspace is currently collapsed to the engine pane. */
  readonly zen: boolean
  /** Flip zen and persist the new intent. */
  toggleZen: () => void
}

export function useZenMode(deps: { kv: KVContext; focus: FocusContextValue }): ZenMode {
  const { kv, focus } = deps
  const [zen, setZen] = useState(() => kv.get(ZEN_ACTIVE_KEY, false) === true)

  function toggleZen(): void {
    const next = !zen
    setZen(next)
    kv.set(ZEN_ACTIVE_KEY, next)
    if (next) focus.setFocused("workspace")
  }

  // Reaching the file tree means the user wants the panes back, so zen drops
  // for this session — but deliberately WITHOUT persisting. It's a transient
  // layout reaction, not a change of intent; writing here would let one click
  // on the file tree silently clear "Start in zen mode".
  useEffect(() => {
    if (focus.focused === "files") setZen(false)
  }, [focus.focused])

  return { zen, toggleZen }
}
