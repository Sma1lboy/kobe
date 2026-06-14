/**
 * Coalescing + trailing-debounce coordination for the two tmux geometry
 * hooks that re-pin / capture a session's layout (`window-resized` →
 * heal, `window-layout-changed` → capture).
 *
 * Why this exists. Both hooks fire as tmux `run-shell -b` commands, so
 * every event spawns a fresh `kobe` CLI process. During a continuous
 * terminal drag or rail drag tmux fires the hook many times in a burst.
 * The pre-coordination heal did its full work (server-option read +
 * `list-panes` + a `resize-pane` sequence — several tmux round-trips) on
 * EVERY one of those processes, and `-b` let them run concurrently and
 * thrash each other. The cold `bun` start per hook firing is unavoidable
 * (tmux hooks can only run a shell command), but the heavy work and the
 * concurrency are not: a file-based generation marker lets a burst of N
 * firings collapse to ONE actual heal/capture, run AFTER the burst settles.
 *
 * The mechanism is a trailing debounce with no lock:
 *
 *   1. Each firing stamps a fresh nonce (+ wall-clock ms) into a per-session
 *      gen file and remembers its own nonce.
 *   2. It sleeps `debounceMs`.
 *   3. It re-reads the gen file. If the nonce changed, a LATER firing
 *      superseded it → it bails and does no work. If the nonce is still its
 *      own, it was the last firing of the burst → it runs the work once.
 *
 * Exactly one firing of a burst survives to do the work (the last one), so
 * there is never a concurrent heal, and the work lands once the geometry has
 * settled. A separate `resize` recency stamp (bumped by every heal path) lets
 * the capture hook read "did a resize/heal just happen" ({@link genAgeMs}) to
 * keep a terminal-resize reflow from being mis-captured as a manual drag.
 *
 * All fs failures degrade to "proceed" (run the work), i.e. to the
 * pre-coordination always-run behaviour — never to a silent no-op.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { kobeStateDir } from "@/env"

/**
 * Gen-file suffixes. `heal` / `capture` are coalesce-nonce protocols (one per
 * trailing-debounce). `resize` is a pure recency timestamp — stamped by EVERY
 * heal path (the `healWorkspaceLayout` choke point + the direct pre-switch /
 * pre-attach resizes), read by the capture guard ({@link genAgeMs}) so a
 * terminal-resize reflow is never mis-captured as a manual drag. Keeping it a
 * SEPARATE kind from `heal` is deliberate: the `heal` nonce file is rewritten by
 * the coalesce protocol, so reusing it for recency would let a re-stamp clobber
 * an in-flight coalesce decision.
 */
export type LayoutCoordKind = "heal" | "capture" | "resize"

/**
 * Trailing-debounce window. A hook firing waits this long for a quieter
 * firing to supersede it before doing work — long enough to swallow a drag's
 * event burst, short enough that the settle feels immediate.
 */
export const LAYOUT_COALESCE_MS = 120

/**
 * How long after the last `resize` recency stamp a `window-layout-changed`
 * capture treats the geometry as "owned by an in-flight resize" and skips.
 * Must exceed {@link LAYOUT_COALESCE_MS} plus a heal's run time so the brief
 * post-settle / pre-heal window (where the rail is still reflow-corrupted) is
 * covered; after it, the heal has re-pinned to the global, so a late capture
 * would only re-capture the global (a no-op) anyway.
 */
export const RESIZE_GUARD_MS = 400

/** `<home>/.kobe/layout-coord/` — gen files live here, cleaned by `kobe reset`. */
function coordDir(): string {
  return join(kobeStateDir(), "layout-coord")
}

/** Per-session, per-kind gen file. Session name is hashed so it is path-safe. */
function genPath(session: string, kind: LayoutCoordKind): string {
  const hash = createHash("sha1").update(session).digest("hex").slice(0, 16)
  return join(coordDir(), `${hash}.${kind}`)
}

/**
 * Stamp a fresh `<ms>\n<nonce>` into the gen file and return the nonce. Written
 * atomically (temp + rename) so a concurrent reader — many `kobe` hook
 * processes write the same file under `-b` — never observes a torn (truncated /
 * interleaved) file; rename on the same fs is atomic.
 */
export function recordGen(session: string, kind: LayoutCoordKind): string {
  const nonce = randomUUID()
  try {
    mkdirSync(coordDir(), { recursive: true })
    const path = genPath(session, kind)
    const tmp = `${path}.${nonce}.tmp`
    writeFileSync(tmp, `${Date.now()}\n${nonce}`)
    renameSync(tmp, path)
  } catch {
    // fs unavailable → caller still proceeds (isLatestGen degrades to true).
  }
  return nonce
}

/**
 * True when `nonce` is still the latest stamp (no later firing superseded
 * this one). Unreadable gen file → `true` (proceed): a duplicate heal is
 * idempotent, a skipped one is not.
 */
export function isLatestGen(session: string, kind: LayoutCoordKind, nonce: string): boolean {
  try {
    return readFileSync(genPath(session, kind), "utf8").split("\n")[1]?.trim() === nonce
  } catch {
    return true
  }
}

/** ms since the last stamp of `kind` (`Infinity` if never stamped / unreadable). */
export function genAgeMs(session: string, kind: LayoutCoordKind, now: number = Date.now()): number {
  try {
    const ts = Number.parseInt(readFileSync(genPath(session, kind), "utf8").split("\n")[0] ?? "", 10)
    return Number.isFinite(ts) ? now - ts : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Run `work` only if this firing is the last of its burst (trailing debounce).
 * Stamps the gen, waits `debounceMs`, and runs `work` once iff no later firing
 * stamped over it. `debounceMs <= 0` skips the wait (test seam).
 */
export async function coalesceLayoutWork(
  session: string,
  kind: LayoutCoordKind,
  work: () => Promise<void>,
  debounceMs: number = LAYOUT_COALESCE_MS,
): Promise<void> {
  const nonce = recordGen(session, kind)
  if (debounceMs > 0) await new Promise((resolve) => setTimeout(resolve, debounceMs))
  if (!isLatestGen(session, kind, nonce)) return
  await work()
}
