/**
 * Locks the O18 title-subscription store's two correctness properties that
 * the two hand-written copies had drifted on: (1) instance-compared reconcile
 * — a release + respawn at the SAME ptyKey drops the dead PTY's stale title
 * and re-subscribes to the fresh one (the old TerminalSplit `has(id)` check
 * froze here), and (2) subscription is keyed by the GLOBALLY-UNIQUE ptyKey, so
 * two keys that would collide as bare leaf ids stay isolated (the cross-tab
 * bleed). Drives a fake PTY set through the injectable `PtyLookup`.
 */

import { describe, expect, it } from "vitest"
import { titleDisplayName, vendorFromTerminalTitle } from "../../src/engine/registry"
import { createTitleSubscriptions } from "../../src/tui-react/workspace/title-subscriptions"
import type { TaskPtyLike } from "../../src/tui/panes/terminal/pty-types"

/** Minimal fake: only the title stream the store touches, fires immediately
 *  with the current title on subscribe (real + mock PTYs both do). */
function fakePty(initial?: string): TaskPtyLike & { emit(title: string): void } {
  const listeners = new Set<(t: string) => void>()
  let current = initial ?? ""
  return {
    emit(title: string) {
      current = title
      for (const l of listeners) l(title)
    },
    onTitleChange(cb: (t: string) => void) {
      listeners.add(cb)
      if (current) cb(current)
      return () => listeners.delete(cb)
    },
  } as unknown as TaskPtyLike & { emit(title: string): void }
}

describe("createTitleSubscriptions", () => {
  it("seeds the current title on attach and tracks changes", () => {
    const pty = fakePty("zsh")
    const store = createTitleSubscriptions((key) => (key === "k1" ? pty : null))
    expect(store.reconcile(["k1"])).toBe(true)
    expect(store.get("k1")).toBe("zsh")

    let notified = 0
    store.subscribe(() => notified++)
    pty.emit("vim")
    expect(store.get("k1")).toBe("vim")
    expect(notified).toBe(1)
  })

  it("re-subscribes on a same-key PTY instance swap (respawn), dropping the dead title", () => {
    const dead = fakePty("vim")
    const fresh = fakePty("zsh")
    let live: TaskPtyLike = dead
    const store = createTitleSubscriptions((key) => (key === "k1" ? live : null))

    store.reconcile(["k1"])
    expect(store.get("k1")).toBe("vim")

    // Release + respawn: the registry now hands back a different instance.
    live = fresh
    // Instance-compared reconcile must swap to the fresh PTY's title, not
    // freeze on the dead one's "vim".
    expect(store.reconcile(["k1"])).toBe(true)
    expect(store.get("k1")).toBe("zsh")

    // The dead PTY's later title change must NOT leak in (we unsubscribed).
    dead.emit("htop")
    expect(store.get("k1")).toBe("zsh")
  })

  // The store normalizes raw OSC titles to display names (titleDisplayName),
  // and `use-turn-polls` feeds those into `targetFor` → `vendorFromTerminalTitle`.
  // Vendor resolution MUST survive that normalization, or a user-typed engine
  // gets no turn detector.
  it("stores display names that still resolve to the same vendor as the raw title", () => {
    for (const raw of ["✳ Claude Code", "claude", "codex — session", "vim", "zsh"]) {
      const pty = fakePty(raw)
      const store = createTitleSubscriptions((key) => (key === "k" ? pty : null))
      store.reconcile(["k"])
      expect(store.get("k")).toBe(titleDisplayName(raw))
      expect(vendorFromTerminalTitle(store.get("k") ?? "")).toBe(vendorFromTerminalTitle(raw))
    }
  })

  it("isolates titles by ptyKey — no bleed between keys", () => {
    const a = fakePty("claude")
    const b = fakePty("codex")
    const store = createTitleSubscriptions((key) => (key === "a" ? a : key === "b" ? b : null))
    store.reconcile(["a", "b"])
    expect(store.get("a")).toBe("claude")
    expect(store.get("b")).toBe("codex")
    a.emit("vim")
    expect(store.get("a")).toBe("vim")
    expect(store.get("b")).toBe("codex") // untouched
  })

  it("drops a key that is no longer requested", () => {
    const pty = fakePty("zsh")
    const store = createTitleSubscriptions((key) => (key === "k1" ? pty : null))
    store.reconcile(["k1"])
    expect(store.get("k1")).toBe("zsh")
    store.reconcile([]) // key gone
    expect(store.get("k1")).toBeUndefined()
    // A late emit from the (now-unsubscribed) PTY must not resurrect it.
    pty.emit("vim")
    expect(store.get("k1")).toBeUndefined()
  })
})
