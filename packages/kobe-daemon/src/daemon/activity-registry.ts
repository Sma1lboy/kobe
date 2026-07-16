import type { EngineActivityDetail, EngineActivityKind, TaskActivityState } from "./contracts.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { ChannelPayloads } from "./protocol.ts"

function reduceActivity(
  _previous: TaskActivityState | undefined,
  kind: EngineActivityKind,
  detail?: EngineActivityDetail,
): TaskActivityState {
  switch (kind) {
    case "session-start":
    case "session-end":
      return "idle"
    case "turn-start":
      return "running"
    case "turn-complete":
      return "turn_complete"
    case "turn-failed":
      return detail?.failure === "rate_limit" || detail?.failure === "billing" ? "rate_limited" : "error"
    case "awaiting-input":
      // Permission prompt OR a question dialog — either way the engine is
      // blocked on the user (`detail.waiting` keeps which). Mirrors
      // kobe/src/engine/hook-events.ts.
      return "permission_needed"
  }
}

/** How long a non-idle, non-complete engine-activity state survives with no
 *  follow-up event before lapsing to idle (safety net for a missed Stop/SessionEnd). */
export const DEFAULT_ENGINE_STATE_TTL_MS = 10 * 60 * 1000

/**
 * States that persist until the NEXT real hook event clears them, rather than
 * lapsing to idle on a stale liveness probe. `running` is the only state the
 * lapse watchdog polices (a missed Stop pinning it forever); every other
 * non-idle state is terminal-until-next-event:
 *
 *   - `turn_complete` keeps its checkmark until the next activity.
 *   - `permission_needed` / `error` / `rate_limited` are exactly the states a
 *     user leaves the session to attend to. The liveness probe is the transcript
 *     mtime, and an engine BLOCKED on a permission prompt / rate limit / error
 *     writes nothing — so the probe always reads "stale" and the old watchdog
 *     idled precisely the tasks that needed a human, hiding the ? badge after
 *     ~10min. They clear naturally: an approved turn emits Stop → turn_complete,
 *     an exit emits SessionEnd → idle, and clearTask() / task deletion wipe them.
 */
const STICKY_STATES: ReadonlySet<TaskActivityState> = new Set([
  "turn_complete",
  "permission_needed",
  "error",
  "rate_limited",
])

export function resolveEngineStateTtlMs(): number {
  const raw = process.env.KOBE_ENGINE_STATE_TTL_MS
  if (raw === undefined) return DEFAULT_ENGINE_STATE_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENGINE_STATE_TTL_MS
}

/**
 * Liveness probe: latest engine-transcript mtime (epoch ms) for a task, or
 * `undefined` when it can't be determined (unknown task, no worktree, probe
 * error). Used by the lapse watchdog to tell a genuinely-silent engine (a
 * missed Stop ⇒ idle) apart from a long single turn that is still writing
 * tool output to its transcript (alive ⇒ keep the badge, re-arm). Filesystem-
 * only; never throws (a rejection is treated as `undefined` ⇒ lapse).
 */
export type ActivityLivenessProbe = (taskId: string) => Promise<number | undefined>

/** The reporting engine's own session identity (from its hook payload). */
export interface EngineSessionInfo {
  readonly id: string
  readonly transcriptPath?: string
}

interface ActivityEntry {
  state: TaskActivityState
  detail?: EngineActivityDetail
  at: number
  /** Carried forward across events that omit it — most hooks pipe it, but
   *  the latest-known id must survive an event from an older `kobe hook`. */
  session?: EngineSessionInfo
  lapse?: ReturnType<typeof setTimeout>
}

export type EngineStatePayload = ChannelPayloads["engine-state"]

/**
 * In-memory, daemon-owned activity registry for hook-driven engine badges.
 *
 * This is UI state, not task lifecycle: it is replayed to subscribers and the
 * web snapshot, but never persisted to tasks.json.
 */
export class DaemonActivityRegistry {
  private readonly activity = new Map<string, ActivityEntry>()
  /** Per-tab entries (taskId → tabId → entry) for events that carried a
   *  `tabId`. UI state like everything here — replayed, never persisted. */
  private readonly tabActivity = new Map<string, Map<string, ActivityEntry>>()

  constructor(
    private readonly bus: DaemonEventBus,
    private readonly staleMs = resolveEngineStateTtlMs(),
    private readonly now = () => Date.now(),
    /**
     * Optional liveness probe. When omitted, the lapse watchdog idles a stale
     * state unconditionally (the pre-liveness behavior — existing unit tests
     * that don't wire a probe keep it). When supplied, the watchdog first asks
     * whether the engine is still writing its transcript before idling.
     */
    private readonly livenessAt: ActivityLivenessProbe = () => Promise.resolve(undefined),
  ) {}

  report(
    taskId: string,
    kind: EngineActivityKind,
    detail?: EngineActivityDetail,
    tabId?: string,
    session?: EngineSessionInfo,
  ): void {
    const prev = this.activity.get(taskId)
    if (prev?.lapse) clearTimeout(prev.lapse)
    const state = reduceActivity(prev?.state, kind, detail)
    const at = this.now()
    const entry: ActivityEntry = { state, detail, at, session: session ?? prev?.session }
    // Safety net: only `running` is policed by the lapse watchdog — a missed
    // Stop/SessionEnd must not pin it forever, so it lapses to idle once the
    // engine genuinely goes silent (heartbeat probe below). Sticky states
    // (turn_complete + the attention states a user walks away to handle) stay
    // visible until the next real event clears them; see {@link STICKY_STATES}.
    if (state !== "idle" && !STICKY_STATES.has(state)) {
      entry.lapse = this.armLapse(taskId, at)
    }
    this.activity.set(taskId, entry)
    // Per-tab ledger (the F7 attention jump's tab precision + the tab
    // strip's hook-driven chip). The task-level entry above stays the
    // last-event-wins rollup every existing consumer reads; this map only
    // adds "which tab". reduceActivity ignores `prev`, so one reduction
    // serves both levels. Idle deletes the entry — a closed/ended tab must
    // not linger as a candidate. Tab entries get their OWN lapse watchdog
    // (a copy, not the shared task entry): the tab chip keys off `running`
    // now, so a missed Stop must not pin the ● — same probe-then-idle
    // heartbeat as the task level, publishing a per-tab idle so hook-wins
    // subscribers fall back to the quiescence poll.
    if (tabId) {
      const tabs = this.tabActivity.get(taskId) ?? new Map<string, ActivityEntry>()
      const prevTab = tabs.get(tabId)
      if (prevTab?.lapse) clearTimeout(prevTab.lapse)
      if (state === "idle") tabs.delete(tabId)
      else {
        const tabEntry: ActivityEntry = { state, detail, at, session: session ?? prevTab?.session }
        if (!STICKY_STATES.has(state)) tabEntry.lapse = this.armTabLapse(taskId, tabId, at)
        tabs.set(tabId, tabEntry)
      }
      if (tabs.size > 0) this.tabActivity.set(taskId, tabs)
      else this.tabActivity.delete(taskId)
    }
    this.bus.publish("engine-state", this.payload(taskId, entry, tabId))
  }

  /**
   * Arm (or re-arm) the lapse watchdog for the entry stamped `at`. A long
   * single turn emits only `turn-start` … `Stop` over many minutes — nothing
   * in between — so a fixed timer would fire mid-turn and wrongly idle a
   * working agent. Bumping the TTL only moves that cliff. Instead, when the
   * timer fires we probe whether the engine is still writing its transcript:
   * a write within the trailing `staleMs` window ⇒ the turn is alive, so we
   * re-arm (a heartbeat) instead of idling. Only a genuinely silent engine
   * (no recent write ⇒ a missed Stop / hung process) lapses to idle.
   */
  private armLapse(taskId: string, at: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.handleLapse(taskId, at)
    }, this.staleMs)
    timer.unref?.()
    return timer
  }

  /** Per-tab sibling of {@link armLapse} — same probe-then-idle heartbeat,
   *  scoped to one (taskId, tabId) entry. */
  private armTabLapse(taskId: string, tabId: string, at: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.handleTabLapse(taskId, tabId, at)
    }, this.staleMs)
    timer.unref?.()
    return timer
  }

  /** Per-tab sibling of {@link handleLapse}: same supersede guards (re-read
   *  before AND after the probe, match on `at`), same liveness heartbeat;
   *  on a genuine lapse the tab entry is deleted and a per-tab idle is
   *  published so subscribers drop the hook claim for that tab. */
  private async handleTabLapse(taskId: string, tabId: string, at: number): Promise<void> {
    const before = this.tabActivity.get(taskId)?.get(tabId)
    if (!before || before.at !== at) return

    let mtime: number | undefined
    try {
      mtime = await this.livenessAt(taskId)
    } catch {
      mtime = undefined
    }

    const tabs = this.tabActivity.get(taskId)
    const cur = tabs?.get(tabId)
    if (!tabs || !cur || cur.at !== at) return

    if (mtime !== undefined && mtime > this.now() - this.staleMs) {
      cur.lapse = this.armTabLapse(taskId, tabId, at)
      return
    }

    tabs.delete(tabId)
    if (tabs.size === 0) this.tabActivity.delete(taskId)
    this.bus.publish("engine-state", { taskId, tabId, state: "idle", at: this.now() })
  }

  /**
   * Lapse-timer callback. Never throws. Guards against the entry changing
   * across the async probe: a `report()` / `clearTask()` / `close()` that runs
   * before OR during the probe supersedes this lapse (re-read the map and
   * confirm the same `at` both before and after the await). A rescheduled
   * lapse is stored back on the live entry, so a later event can cancel it.
   */
  private async handleLapse(taskId: string, at: number): Promise<void> {
    // Superseded before we even probed (a fresh report swapped the entry).
    const before = this.activity.get(taskId)
    if (!before || before.at !== at) return

    let mtime: number | undefined
    try {
      mtime = await this.livenessAt(taskId)
    } catch {
      // Probe failure ⇒ treat as silent and fall back to lapsing. Never crash
      // the daemon over a best-effort filesystem read.
      mtime = undefined
    }

    // Re-read after the await: the entry may have been replaced or cleared
    // while the probe was in flight. Acting on a stale `at` would clobber a
    // newer state or resurrect a cleared task.
    const cur = this.activity.get(taskId)
    if (!cur || cur.at !== at) return

    // Alive iff the transcript was written within the trailing staleness
    // window. Using "within the last staleMs" (rather than strictly after
    // `at`) is what makes the heartbeat correct across re-arms: each window
    // demands a FRESH write, so a continuously-writing turn stays lit forever
    // while a turn that actually went quiet lapses within one more `staleMs`.
    if (mtime !== undefined && mtime > this.now() - this.staleMs) {
      cur.lapse = this.armLapse(taskId, at)
      return
    }

    this.publishIdle(taskId)
  }

  clearTask(taskId: string): void {
    const gone = this.activity.get(taskId)
    if (gone?.lapse) clearTimeout(gone.lapse)
    this.activity.delete(taskId)
    // Per-tab entries go with the task; explicit per-tab idles so every
    // subscriber drops its tab-level candidates too.
    const tabs = this.tabActivity.get(taskId)
    this.tabActivity.delete(taskId)
    if (tabs) {
      for (const [tabId, tabEntry] of tabs) {
        if (tabEntry.lapse) clearTimeout(tabEntry.lapse)
        this.bus.publish("engine-state", { taskId, tabId, state: "idle", at: this.now() })
      }
    }
    // Publish an explicit idle so every subscriber clears this task's badge.
    // The bus only caches one last value per channel, so this also prevents a
    // stale per-task replay if the id is quickly recreated.
    if (gone) this.bus.publish("engine-state", { taskId, state: "idle", at: this.now() })
  }

  snapshotByTask(): Record<string, EngineStatePayload> {
    const out: Record<string, EngineStatePayload> = {}
    for (const [taskId, entry] of this.activity) out[taskId] = this.payload(taskId, entry)
    return out
  }

  currentNonIdle(): EngineStatePayload[] {
    const out: EngineStatePayload[] = []
    for (const [taskId, entry] of this.activity) {
      if (entry.state !== "idle") out.push(this.payload(taskId, entry))
    }
    // Tab entries ride the same replay so a late subscriber rebuilds its
    // per-tab map too (they're only stored non-idle).
    for (const [taskId, tabs] of this.tabActivity) {
      for (const [tabId, entry] of tabs) out.push(this.payload(taskId, entry, tabId))
    }
    return out
  }

  close(): void {
    for (const entry of this.activity.values()) {
      if (entry.lapse) clearTimeout(entry.lapse)
    }
    for (const tabs of this.tabActivity.values()) {
      for (const entry of tabs.values()) {
        if (entry.lapse) clearTimeout(entry.lapse)
      }
    }
    this.activity.clear()
    this.tabActivity.clear()
  }

  private publishIdle(taskId: string): void {
    const entry: ActivityEntry = { state: "idle", at: this.now() }
    this.activity.set(taskId, entry)
    this.bus.publish("engine-state", this.payload(taskId, entry))
  }

  private payload(taskId: string, entry: ActivityEntry, tabId?: string): EngineStatePayload {
    return {
      taskId,
      ...(tabId ? { tabId } : {}),
      state: entry.state,
      ...(entry.detail ? { detail: entry.detail } : {}),
      ...(entry.session ? { sessionId: entry.session.id } : {}),
      ...(entry.session?.transcriptPath ? { transcriptPath: entry.session.transcriptPath } : {}),
      at: entry.at,
    }
  }
}
