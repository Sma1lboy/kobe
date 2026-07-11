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
 * Raw OSC titles are normalized through `titleDisplayName` so an engine's
 * decorated window title ("✳ Claude Code") reads as its binary ("claude"),
 * one vocabulary across corner tags and tab labels.
 *
 * No React, no Solid, no @opentui — plain closures over Maps, unit-testable
 * under vitest. Callers own the tick that drives `reconcile()` (a PTY spawns
 * asynchronously after its Terminal mounts, so the attach must retry).
 */

import { useEffect, useRef, useState } from "react"
import { titleDisplayName } from "../../engine/registry"
import type { TaskPtyLike } from "../../tui/panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"

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
  /** ptyKey → { the subscribed PTY instance, its unsub, latest display title }. */
  const subs = new Map<string, { pty: TaskPtyLike; unsub: () => void; title: string }>()
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
        // onTitleChange fires immediately with the current title (mock + real
        // both do), so `title` is seeded synchronously here.
        const entry = { pty, unsub: () => {}, title: "" }
        entry.unsub = pty.onTitleChange((raw) => {
          const display = titleDisplayName(raw)
          if (entry.title === display) return
          entry.title = display
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
 * component's lifetime, drives its reconcile from the given `ptyKeys` map on
 * every render AND a 2s lazy-attach tick, and returns the requested-id → live
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
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), TITLE_ATTACH_MS)
    return () => clearInterval(timer)
  }, [])

  // Reconcile on every render (ptyKeys changed) and every retry tick (a PTY
  // may have just spawned). Rebuild the id→title view only when something
  // actually moved — identity-stable so idle renders don't allocate a Map.
  useEffect(() => {
    void tick
    store.reconcile(ptyKeys.values())
    setTitles((prev) => {
      const next = new Map<string, string>()
      for (const [id, key] of ptyKeys) {
        const title = store.get(key)
        if (title !== undefined) next.set(id, title)
      }
      if (next.size === prev.size && [...next].every(([id, v]) => prev.get(id) === v)) return prev
      return next
    })
  })

  // Title-change pushes (not caused by a reconcile) re-project the view.
  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), [store])

  useEffect(() => () => store.dispose(), [store])

  return titles
}
