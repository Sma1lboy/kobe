/**
 * Activity observer (issues #11/#16) — the daemon-side ground-truth loop
 * behind the sidebar running dots. Hook events are the primary signal, but
 * they lie by omission: an ESC interrupt fires no hook, a daemon restart
 * wipes the in-memory registry while engines keep running, and a died
 * engine leaves its last claim standing. This loop closes those gaps from
 * facts the hosted-PTY world already has:
 *
 *   - `pty.list` every poll: per-session OSC title + total output bytes.
 *     Output advancing (or the title changing) inside the silence window ⇒
 *     the session is WORKING; both frozen for the whole window ⇒ at rest.
 *     Engines repaint their status line (spinner frame / elapsed timer) at
 *     ≥1Hz while a turn runs, so the silence threshold is ~30× beyond any
 *     working repaint gap — a long "thinking" phase still animates its
 *     title, which is itself PTY output.
 *   - an engine-owned title hint (`titleTurnHint`): claude writes ⠂/⠐
 *     while working and a static ✳ at rest, codex only decorates while
 *     working — a resting title is an event-grade "not working" verdict.
 *     Engines without a declared vocabulary answer null and fall back to
 *     pure silence (never misread as rest).
 *   - a low-frequency foreground WALK (`ps` process-tree, the same
 *     primitive `kobe api inspect` uses): which engine actually runs in
 *     each session. Walk evidence gates every claim, and "no engine" is
 *     positive proof a `running` claim is stale.
 *
 * Findings fold into the registry via `observeTab` (hook events outrank
 * observation; only a stale hook `running` is ever corrected — see there).
 * The FIRST tick runs immediately and includes a walk, so a daemon restart
 * re-seeds busy sessions' dots within seconds (#16) instead of at the next
 * turn boundary.
 */

import { KobeDaemonClient } from "../client/index.ts"
import type { DaemonActivityRegistry } from "./activity-registry.ts"
import { logDaemonInfo } from "./crash-log.ts"
import { defaultPtyHostSocketPath } from "./paths.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

/** Poll cadence — bounds state-flip latency; `pty.list` is one local RPC. */
export const DEFAULT_OBSERVER_POLL_MS = 10_000
/**
 * How long output AND title must both stay frozen before a session reads
 * as resting. Working engines repaint at ≥1Hz (spinner/elapsed timer), so
 * 30s is far beyond any legitimate repaint gap, and ≥3 poll ticks means a
 * single missed/slow poll can't flap the dot.
 */
export const DEFAULT_SILENCE_MS = 30_000
/** Walk cadence in ticks (~60s at the default poll — the issue-#11 reconciler). */
export const DEFAULT_WALK_EVERY_TICKS = 6
/**
 * Never correct a hook-claimed `running` younger than this: at a turn
 * boundary the title/output evidence can trail the hook by one poll, and a
 * fresh turn must not be idled by a stale observation.
 */
export const DEFAULT_CORRECT_AFTER_MS = 20_000

/** One `pty.list` row the observer consumes. */
export interface ObservedPtySession {
  readonly key: string
  readonly alive: boolean
  readonly pid: number | null
  readonly title: string
  /** Monotonic total bytes the child ever wrote — the output heartbeat. */
  readonly totalBytes: number
}

export interface ActivityObserverIo {
  /** Current pty-host inventory; `null` when the host is unreachable
   *  (never spawns one). */
  listSessions(): Promise<readonly ObservedPtySession[] | null>
  /** Foreground engine per session pid (ONE `ps` snapshot walk) — vendor id
   *  or null for "no engine in this tree". */
  foregroundEngines(pids: readonly number[]): Promise<ReadonlyMap<number, string | null>>
  /** Engine-owned title verdict — see kobe's `engineTitleTurnHint`. */
  titleTurnHint(vendor: string, title: string): "working" | "rest" | null
}

export interface ActivityObserverOptions {
  readonly pollMs?: number
  readonly silenceMs?: number
  readonly walkEveryTicks?: number
  readonly correctAfterMs?: number
  readonly log?: (event: string, message: string) => void
}

interface SessionTrack {
  readonly taskId: string
  readonly tabId: string
  firstSeenAt: number
  lastTotalBytes: number
  lastTitle: string
  /** Last time output bytes advanced OR the title changed — null until the
   *  first OBSERVED change. Merely existing is not evidence of work: an
   *  idle engine at its prompt (custom vendor, no title vocabulary) must
   *  read as unknown until something actually moves, not as running for
   *  the first silence window. */
  lastActivityAt: number | null
  /** Last walk verdict: vendor id, null = no engine, undefined = never walked. */
  vendor: string | null | undefined
}

/**
 * Start the observer loop. First tick fires immediately (with a walk — the
 * #16 restart seeding); per-tick work is gated on `hasSubscribers` like the
 * other collectors, so a parked daemon polls nobody. Returns stop().
 */
export function startActivityObserver(
  activity: DaemonActivityRegistry,
  io: ActivityObserverIo,
  hasSubscribers: () => boolean,
  options: ActivityObserverOptions = {},
): () => void {
  const pollMs = options.pollMs ?? DEFAULT_OBSERVER_POLL_MS
  const silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS
  const walkEvery = Math.max(1, options.walkEveryTicks ?? DEFAULT_WALK_EVERY_TICKS)
  const correctAfterMs = options.correctAfterMs ?? DEFAULT_CORRECT_AFTER_MS
  const log = options.log ?? logDaemonInfo
  const tracks = new Map<string, SessionTrack>()
  let tickCount = 0
  let inFlight = false

  const applyRest = (track: Pick<SessionTrack, "taskId" | "tabId" | "vendor">, why: string): void => {
    const outcome = activity.observeTab(track.taskId, track.tabId, "rest", {
      ...(track.vendor ? { vendor: track.vendor } : {}),
      correctHookRunningAfterMs: correctAfterMs,
    })
    if (outcome === "corrected-hook-running") {
      log("activity-observe", `idled hook-claimed running for ${track.taskId}/${track.tabId} (${why})`)
    }
  }

  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      if (!hasSubscribers()) return
      const walkTick = tickCount % walkEvery === 0
      tickCount++
      const listed = await io.listSessions()
      if (listed === null) {
        // Host unreachable — maybe restarting, maybe gone. That is NOT
        // positive evidence against hook claims, so only retire what this
        // loop itself asserted: observed-running entries flip to idle
        // (no `correctHookRunningAfterMs` → hook entries stand).
        for (const [key, track] of tracks) {
          activity.observeTab(track.taskId, track.tabId, "rest", {})
          tracks.delete(key)
        }
        return
      }
      const sessions = listed
      const seen = new Set<string>()

      // Refresh tracks from the inventory (2-segment `taskId::tabId` keys
      // only — split shell leaves are `::leaf-N` sub-keys and carry no tab
      // state of their own).
      const now = Date.now()
      const live: SessionTrack[] = []
      const newborn = new Set<string>()
      for (const s of sessions) {
        const parts = s.key.split("::")
        if (parts.length !== 2 || !parts[0] || !parts[1]) continue
        seen.add(s.key)
        if (!s.alive) {
          // An exited child is positive evidence — even one that was never
          // tracked alive (dead before this daemon's first pass): a stale
          // hook `running` for it must still be corrected.
          const track = tracks.get(s.key)
          applyRest(track ?? { taskId: parts[0], tabId: parts[1], vendor: undefined }, "session exited")
          tracks.delete(s.key)
          continue
        }
        let track = tracks.get(s.key)
        if (!track) {
          track = {
            taskId: parts[0],
            tabId: parts[1],
            firstSeenAt: now,
            lastTotalBytes: s.totalBytes,
            lastTitle: s.title,
            lastActivityAt: null,
            vendor: undefined,
          }
          tracks.set(s.key, track)
          newborn.add(s.key)
        } else if (s.totalBytes !== track.lastTotalBytes || s.title !== track.lastTitle) {
          track.lastTotalBytes = s.totalBytes
          track.lastTitle = s.title
          track.lastActivityAt = now
        }
        live.push(track)
      }

      // Dead or vanished sessions: positive evidence the engine is gone —
      // retire observed claims AND stale hook `running`s.
      for (const [key, track] of tracks) {
        if (seen.has(key) && sessions.some((s) => s.key === key && s.alive)) continue
        applyRest(track, "session gone")
        tracks.delete(key)
      }

      // Foreground walk: every `walkEvery` ticks, plus immediately for
      // sessions first seen this tick (the #16 seeding path).
      const toWalk = live.filter((t) => walkTick || newborn.has(`${t.taskId}::${t.tabId}`) || t.vendor === undefined)
      if (toWalk.length > 0) {
        const pidByKey = new Map<string, number>()
        for (const s of sessions) {
          if (s.alive && s.pid !== null) pidByKey.set(s.key, s.pid)
        }
        try {
          const pids = toWalk
            .map((t) => pidByKey.get(`${t.taskId}::${t.tabId}`))
            .filter((pid): pid is number => pid !== undefined)
          const verdicts = await io.foregroundEngines(pids)
          for (const track of toWalk) {
            const pid = pidByKey.get(`${track.taskId}::${track.tabId}`)
            if (pid !== undefined && verdicts.has(pid)) track.vendor = verdicts.get(pid) ?? null
          }
        } catch {
          // ps failed — keep prior verdicts; sessions never walked stay
          // unclaimed rather than guessed.
        }
      }

      // Claims. Walk evidence gates everything: an unwalked session gets no
      // claim at all (conservative — absence of knowledge is the client's
      // "unknown", not idle). With a walked vendor, precedence is: a
      // resting title (event-grade engine verdict) → rest; observed
      // output/title movement inside the window → working; a WORKING title
      // frame → working, but only until the silence window proves it frozen
      // (the #16 restart seeding path — a busy claude re-lights on the
      // first pass off its ⠂/⠐ frame alone); full silence → rest; a quiet
      // never-moved session with no title verdict → no claim (unknown).
      for (const track of live) {
        const key = `${track.taskId}::${track.tabId}`
        const session = sessions.find((s) => s.key === key)
        if (!session || track.vendor === undefined) continue
        if (track.vendor === null) {
          applyRest(track, "no engine in foreground")
          continue
        }
        const silentForMs = now - (track.lastActivityAt ?? track.firstSeenAt)
        const hint = io.titleTurnHint(track.vendor, session.title)
        const claimWorking = (why: string): void => {
          const outcome = activity.observeTab(track.taskId, track.tabId, "working", {
            vendor: track.vendor ?? undefined,
          })
          if (outcome === "observed-running") {
            log("activity-observe", `seeded running for ${track.taskId}/${track.tabId} (${why})`)
          }
        }
        if (hint === "rest") applyRest(track, "engine title at rest")
        else if (track.lastActivityAt !== null && now - track.lastActivityAt < silenceMs) claimWorking("live output")
        else if (hint === "working" && silentForMs < silenceMs) claimWorking("working title frame")
        else if (silentForMs >= silenceMs) applyRest(track, `no output for ${Math.round(silentForMs / 1000)}s`)
        // else: quiet, never moved, no verdict — stays unknown.
      }
    } catch {
      // Observation is best-effort; a failed tick must never hurt the daemon.
    } finally {
      inFlight = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), pollMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Production IO: `pty.list` against the standalone pty host's socket
 * (NEVER spawns one; unreachable reads as null — same contract as
 * `ptyHostHasLiveSessions`), walk + title vocabulary via the injected
 * runtime adapter (engine knowledge stays kobe-owned).
 */
export function createActivityObserverIo(
  homeDir: string | undefined,
  runtime: Pick<DaemonRuntimeAdapter, "foregroundEngines" | "titleTurnHint">,
): ActivityObserverIo {
  return {
    async listSessions() {
      const client = new KobeDaemonClient(defaultPtyHostSocketPath(homeDir))
      try {
        await client.connect()
        const result = await client.request<{
          sessions?: Array<{ key?: string; alive?: boolean; pid?: number | null; title?: string; totalBytes?: number }>
        }>("pty.list")
        return (result.sessions ?? []).map((s) => ({
          key: s.key ?? "",
          alive: s.alive === true,
          pid: typeof s.pid === "number" ? s.pid : null,
          title: typeof s.title === "string" ? s.title : "",
          totalBytes: typeof s.totalBytes === "number" ? s.totalBytes : 0,
        }))
      } catch {
        return null
      } finally {
        client.close()
      }
    },
    foregroundEngines: (pids) => runtime.foregroundEngines(pids),
    titleTurnHint: (vendor, title) => runtime.titleTurnHint(vendor, title),
  }
}
