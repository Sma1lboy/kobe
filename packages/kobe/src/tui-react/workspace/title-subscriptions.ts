/**
 * Framework-free live-title subscription store — the ONE "ptyKey → live
 * foreground-process display title" reconciler shared by the workspace
 * terminal surfaces (O18). Before this, `use-turn-polls.ts` Pass 1 and
 * `TerminalSplit.tsx` each hand-wrote a lazy-attach-with-retry title
 * subscription pass, and they had DRIFTED apart: turn-polls compared PTY
 * INSTANCES (release + respawn at the same key drops the dead PTY's stale
 * title), while TerminalSplit only did a `has(id)` existence check keyed on
 * the bare leaf id — so a split leaf that respawned kept a subscription
 * pinned to the dead PTY (frozen title), and because TerminalSplit mounts
 * without a React key its instance survives tab switches while every tab's
 * leaves start at `leaf-1`, so a subscription from one tab's `leaf-1` bled
 * its title onto the next tab's `leaf-1`. Both bugs vanish once the reconcile
 * is instance-compared and keyed on the GLOBALLY-UNIQUE registry ptyKey
 * (`splitLeafPtyKey(tabKey, id)` / `soloKey(...)`), which is exactly what
 * this store does.
 *
 * The correct reconcile logic is lifted verbatim from `use-turn-polls.ts`
 * Pass 1 (the already-verified writing): for each requested ptyKey, resolve
 * the registry PTY, (re)subscribe when the instance at that key changed, and
 * drop subscriptions whose key is no longer requested or whose PTY died.
 *
 * The STORE keeps titles raw — the OSC stream IS the label (owner
 * 2026-08-01: "don't waste the OSC name"). It once collapsed an engine's
 * title to its binary ("✳ Claude Code" → "claude") via the live-engine
 * vendor, which (a) threw away the one line of live status the engine writes
 * and (b) FLICKERED: the ps-walk probe transiently loses a vendor mid-turn,
 * so labels flapped raw ↔ collapsed every probe tick. Identity (which
 * detector to attach) still comes from the process tree; display no longer
 * does.
 *
 * What the RENDER projections below (and use-turn-polls' twin) do strip is
 * the engine's leading STATUS decoration — claude's `✳`/`⠂`/`⠐`, codex's
 * spinner frame — because kobe draws that state in its own glyph column and
 * showing both says it twice (owner 2026-08-10). That is a display concern,
 * so it lives in the projection, not in the store, and the vocabulary is
 * declared per engine (`terminalTitle.statusPrefixes`). The name itself is
 * still never rewritten.
 *
 * No React, no Solid, no @opentui — plain closures over Maps, unit-testable
 * under vitest. Callers own the tick that drives `reconcile()` (a PTY spawns
 * asynchronously after its Terminal mounts, so the attach must retry).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { stripEngineStatusPrefix } from "../../engine/registry"
import type { TaskPtyLike } from "../../tui/panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { getDefaultLiveEngines } from "../../tui/workspace/live-engine"
import { useLatest } from "../lib/use-latest"

/** A registry lookup — injectable so tests drive a fake PTY set. */
export type PtyLookup = (key: string) => TaskPtyLike | null

export interface TitleSubscriptions {
  /**
   * Reconcile the live subscription set to exactly `ptyKeys`. Instance-
   * compared: a key whose registry PTY instance changed since last time
   * (release + respawn) re-subscribes against the fresh PTY, dropping the
   * dead one's stale title. Returns true when any display title changed as
   * a result (a caller can skip re-rendering when nothing moved).
   */
  reconcile(ptyKeys: Iterable<string>): boolean
  /** Latest display title for a ptyKey, or undefined if none seen yet. */
  get(key: string): string | undefined
  /** Subscribe to title changes (fires on any reconcile that moved a title). */
  subscribe(listener: () => void): () => void
  /** Drop every subscription — final teardown. */
  dispose(): void
}

export function createTitleSubscriptions(
  lookup: PtyLookup = getDefaultPtyRegistry().get.bind(getDefaultPtyRegistry()),
): TitleSubscriptions {
  /** ptyKey → the subscribed PTY instance, its unsub, and its raw OSC title. */
  /** `title` is undefined until the PTY reports one — see the seeding note below. */
  type Entry = { pty: TaskPtyLike; unsub: () => void; title: string | undefined }
  const subs = new Map<string, Entry>()
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const l of listeners) l()
  }

  return {
    reconcile(ptyKeys) {
      const wanted = new Set(ptyKeys)
      let changed = false

      // Drop subscriptions no longer wanted OR whose PTY instance changed
      // (release + respawn) — the dead PTY's title must not linger.
      for (const [key, sub] of subs) {
        const cur = wanted.has(key) ? lookup(key) : null
        if (cur === sub.pty) continue
        sub.unsub()
        subs.delete(key)
        changed = true
      }

      // Attach to newly-wanted keys once their PTY exists (lazy — a leaf's
      // PTY spawns after its Terminal mounts, so absent keys retry next tick).
      for (const key of wanted) {
        if (subs.has(key)) continue
        const pty = lookup(key)
        if (!pty) continue
        // onTitleChange replays the CURRENT title synchronously when there
        // is one, so `title` is seeded below. Until then it stays
        // `undefined` — NOT `""`: `get()` returning an empty string reads as
        // "this tab's live title is empty" instead of "nothing reported
        // yet", and the host records that over the tab's real `lastTitle`
        // (use-tab-turn-state), wiping the name to the vendor default a beat
        // after the correct one rendered (owner report 2026-08-10).
        const entry: Entry = { pty, unsub: () => {}, title: undefined }
        entry.unsub = pty.onTitleChange((raw) => {
          if (entry.title === raw) return
          entry.title = raw
          emit()
        })
        subs.set(key, entry)
        changed = true
      }

      return changed
    },
    get(key) {
      return subs.get(key)?.title
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      for (const sub of subs.values()) sub.unsub()
      subs.clear()
      listeners.clear()
    },
  }
}

/** Retry cadence: a leaf/tab PTY spawns asynchronously after mount. */
const TITLE_ATTACH_MS = 2000

/**
 * React binding for {@link createTitleSubscriptions}: owns one store for the
 * component's lifetime, drives its reconcile whenever the given `ptyKeys` map
 * changes AND on a 2s lazy-attach tick AND on title pushes (the tick and the
 * pushes call the stable reconcile directly — no render-tick state, so a
 * no-change tick re-renders nothing), and returns the requested-id → live
 * display title map for render. `ptyKeys` maps a caller-chosen id (a leaf id,
 * a tab id) to its GLOBALLY-UNIQUE registry ptyKey — the id keys the returned
 * map, the ptyKey keys the subscription (so no two components' `leaf-1`s
 * collide). Stable identity: an unchanged title set returns the SAME Map so
 * the tick doesn't churn re-renders.
 */
export function useTitleSubscriptions(ptyKeys: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const storeRef = useRef<TitleSubscriptions | null>(null)
  if (storeRef.current === null) storeRef.current = createTitleSubscriptions()
  const store = storeRef.current
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map())
  const ptyKeysRef = useLatest(ptyKeys)

  // Reconcile subscriptions + project ptyKey→title onto id→title. Stable so
  // the retry tick and title pushes call it directly without re-rendering
  // the host; the identity-stable setTitles keeps a no-change run render-free.
  const reconcile = useCallback(() => {
    const keys = ptyKeysRef.current
    store.reconcile(keys.values())
    const liveEngines = getDefaultLiveEngines()
    setTitles((prev) => {
      const next = new Map<string, string>()
      for (const [id, key] of keys) {
        const title = store.get(key)
        if (title === undefined) continue
        // Same rule as use-turn-polls' projection: the engine's own status
        // decoration is stripped before anything renders it, so kobe's glyph
        // column stays the one place turn state is drawn.
        next.set(id, stripEngineStatusPrefix(title, liveEngines.resolve(key) ?? null))
      }
      if (next.size === prev.size && [...next].every(([id, v]) => prev.get(id) === v)) return prev
      return next
    })
  }, [store])

  // Retry tick — a PTY may have just spawned.
  useEffect(() => {
    const timer = setInterval(reconcile, TITLE_ATTACH_MS)
    return () => clearInterval(timer)
  }, [reconcile])

  // Reconcile when the requested key set changes (and once on mount).
  useEffect(() => {
    void ptyKeys
    reconcile()
  }, [ptyKeys, reconcile])

  // Title-change pushes (not caused by a reconcile) re-project the view.
  // Deferred one microtask (coalesced): a fresh subscription seeds its title
  // SYNCHRONOUSLY inside the store's reconcile loop, which must never be
  // re-entered — the old setState tick got this asynchrony for free from React.
  useEffect(() => {
    let active = true
    let scheduled = false
    const unsub = store.subscribe(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (active) reconcile()
      })
    })
    return () => {
      active = false
      unsub()
    }
  }, [store, reconcile])

  useEffect(() => () => store.dispose(), [store])

  return titles
}
