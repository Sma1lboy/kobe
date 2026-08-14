import {
  type EffectiveActivity,
  type HookSlot,
  type ObservedSlot,
  recomputeTabActivity,
} from "./activity-arbitrate.ts"
import {
  type ActivityLiveness,
  type ActivityLivenessProbe,
  type EngineSessionInfo,
  STICKY_STATES,
  reduceActivity,
  resolveEngineStateTtlMs,
} from "./activity-reduce.ts"
import type { EngineActivityDetail, EngineActivityKind, TaskActivityState } from "./contracts.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { ChannelPayloads } from "./protocol.ts"

// Pure reducer + policy constants/types live in activity-reduce.ts (file-size
// cap split); re-exported so this stays the one public entry point. The
// arbitration core likewise lives in activity-arbitrate.ts.
export {
  type ActivityLiveness,
  type ActivityLivenessProbe,
  type EngineSessionInfo,
  DEFAULT_ENGINE_STATE_TTL_MS,
  resolveEngineStateTtlMs,
} from "./activity-reduce.ts"
export {
  type EffectiveActivity,
  type HookSlot,
  type ObservedSlot,
  type TabActivitySlots,
  recomputeTabActivity,
} from "./activity-arbitrate.ts"

/** Task-level rollup entry — last-event-wins across the task's tabs. */
interface ActivityEntry {
  state: TaskActivityState
  detail?: EngineActivityDetail
  at: number
  /** Carried forward across events that omit it — most hooks pipe it, but
   *  the latest-known id must survive an event from an older `kobe hook`. */
  session?: EngineSessionInfo
  /** The reporting engine's id (hook `--engine`) — what the liveness probe
   *  asks about. Carried forward like `session`. */
  vendor?: string
  lapse?: ReturnType<typeof setTimeout>
}

/** A hook slot plus its lapse watchdog — the only slot that gets one. */
interface TabHookEntry extends HookSlot {
  lapse?: ReturnType<typeof setTimeout>
}

/**
 * One tab's activity record, herdr-style: ONE SLOT PER SOURCE, arbitrated by
 * {@link recomputeTabActivity} (see activity-arbitrate.ts for the priority
 * rules). Writers never edit each other's slot — `report()` writes `hook`,
 * `observeTab()` writes `observed` — and `effective` caches the last
 * arbitrated result so a write that changes nothing publishes nothing.
 */
interface TabEntry {
  hook?: TabHookEntry
  observed?: ObservedSlot
  effective: EffectiveActivity
}

/** What `observeTab` did — the caller (activity-observer) logs corrections. */
export type ObserveTabOutcome = "noop" | "observed-running" | "observed-idle" | "corrected-hook-running"

export type EngineStatePayload = ChannelPayloads["engine-state"]

/** The subset of an entry the wire payload reads. */
interface PayloadSource {
  state: TaskActivityState
  detail?: EngineActivityDetail
  session?: EngineSessionInfo
  at: number
}

/**
 * In-memory, daemon-owned activity registry for hook-driven engine badges.
 *
 * This is UI state, not task lifecycle: it is replayed to subscribers and the
 * web snapshot, but never persisted to tasks.json.
 *
 * Two levels: the task-level rollup (last-event-wins across tabs, every
 * existing consumer reads it) and the per-tab ledger (the F7 attention jump's
 * tab precision + the tab strip's chip). The per-tab ledger is where the
 * multi-source arbitration lives: hook events and observer facts occupy
 * separate slots and ONE pure function decides what subscribers see, instead
 * of each writer special-casing the other source's entries.
 */
export class DaemonActivityRegistry {
  private readonly activity = new Map<string, ActivityEntry>()
  /** Per-tab records (taskId → tabId → entry) for events that carried a
   *  `tabId`. UI state like everything here — replayed, never persisted. */
  private readonly tabActivity = new Map<string, Map<string, TabEntry>>()

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
    vendor?: string,
  ): void {
    const prev = this.activity.get(taskId)
    if (prev?.lapse) clearTimeout(prev.lapse)
    const state = reduceActivity(prev?.state, kind, detail)
    const at = this.now()
    const entry: ActivityEntry = {
      state,
      detail,
      at,
      session: session ?? prev?.session,
      vendor: vendor ?? prev?.vendor,
    }
    // Safety net: only `running` is policed by the lapse watchdog — a missed
    // Stop/SessionEnd must not pin it forever, so it lapses to idle once the
    // engine genuinely goes silent (heartbeat probe below). Sticky states
    // (turn_complete + the attention states a user walks away to handle) stay
    // visible until the next real event clears them; see {@link STICKY_STATES}.
    if (state !== "idle" && !STICKY_STATES.has(state)) {
      entry.lapse = this.armLapse(taskId, at)
    }
    this.activity.set(taskId, entry)
    // Per-tab ledger. A TAB-scoped publish must carry the TAB's session
    // lineage only — the event's own id, or the same tab's previous one.
    // Inheriting the task-level rollup here leaked another tab's (even
    // another ENGINE's) session onto a fresh tab whose hooks don't pipe
    // session ids. A hook event SUPERSEDES the observed slot for its tab:
    // hooks are authoritative while the engine lives (see
    // activity-arbitrate.ts), so the observation that filled the gap is
    // dropped rather than left to age against the fresh claim.
    let publishEntry: PayloadSource = entry
    if (tabId) {
      const tabs = this.tabActivity.get(taskId) ?? new Map<string, TabEntry>()
      const prevTab = tabs.get(tabId)
      if (prevTab?.hook?.lapse) clearTimeout(prevTab.hook.lapse)
      const tabSession = session ?? prevTab?.hook?.session
      const tabVendor = vendor ?? prevTab?.hook?.vendor
      publishEntry = { state, detail, at, session: tabSession }
      if (state === "idle") {
        // A closed/ended tab must not linger as a candidate — idle CLEARS
        // the tab's record (both slots) rather than being stored.
        tabs.delete(tabId)
      } else {
        const hook: TabHookEntry = { state, detail, at, session: tabSession, vendor: tabVendor }
        if (!STICKY_STATES.has(state)) hook.lapse = this.armTabLapse(taskId, tabId, at)
        tabs.set(tabId, {
          hook,
          effective: {
            state,
            at,
            source: "hook",
            ...(detail ? { detail } : {}),
            ...(tabVendor ? { vendor: tabVendor } : {}),
            ...(tabSession ? { session: tabSession } : {}),
          },
        })
      }
      if (tabs.size > 0) this.tabActivity.set(taskId, tabs)
      else this.tabActivity.delete(taskId)
    }
    this.bus.publish("engine-state", this.payload(taskId, publishEntry, tabId))
  }

  /** Probe wrapper: a best-effort filesystem read must never crash the daemon,
   *  and a failure reads as "silent" ⇒ lapse. */
  private async probe(taskId: string, vendor?: string, transcriptPath?: string): Promise<ActivityLiveness | undefined> {
    try {
      return await this.livenessAt(taskId, vendor, transcriptPath)
    } catch {
      return undefined
    }
  }

  /**
   * Is the engine still mid-turn? THE single definition behind both lapse
   * watchdogs (task + tab), deliberately shared so the two cannot drift.
   *
   * A fresh transcript write means "the engine is alive", which used to be
   * read as "the turn is still running". Those are different claims: an
   * engine parked at its prompt waiting for the user keeps touching its
   * transcript, so with a missed Stop every lapse re-armed and the spinner
   * span forever (the "kobe shows running long after it stopped" report).
   *
   * A completion marker at/after the turn started settles it — the last
   * thing that happened WAS this turn ending, so stop re-arming regardless
   * of how recent the writes are. Only with no such marker does a fresh
   * write keep the badge lit, which is the long-single-turn case the
   * heartbeat exists for.
   */
  private stillWorking(live: ActivityLiveness | undefined, at: number): boolean {
    if (!live) return false
    if (live.completedAt !== undefined && live.completedAt >= at) return false
    return live.mtimeMs !== undefined && live.mtimeMs > this.now() - this.staleMs
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
   *  scoped to one (taskId, tabId) hook slot. */
  private armTabLapse(taskId: string, tabId: string, at: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.handleTabLapse(taskId, tabId, at)
    }, this.staleMs)
    timer.unref?.()
    return timer
  }

  /** Per-tab sibling of {@link handleLapse}: same supersede guards (re-read
   *  before AND after the probe, match on `at`), same liveness heartbeat.
   *  Only the HOOK slot is policed (observed entries carry no watchdog — the
   *  observer's own poll retires them); on a genuine lapse the whole tab
   *  record is dropped and a per-tab idle is published so hook-wins
   *  subscribers fall back to the quiescence poll. */
  private async handleTabLapse(taskId: string, tabId: string, at: number): Promise<void> {
    const before = this.tabActivity.get(taskId)?.get(tabId)?.hook
    if (!before || before.at !== at) return

    const live = await this.probe(taskId, before.vendor, before.session?.transcriptPath)

    const tabs = this.tabActivity.get(taskId)
    const cur = tabs?.get(tabId)?.hook
    if (!tabs || !cur || cur.at !== at) return

    if (this.stillWorking(live, at)) {
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

    const live = await this.probe(taskId, before.vendor, before.session?.transcriptPath)

    // Re-read after the await: the entry may have been replaced or cleared
    // while the probe was in flight. Acting on a stale `at` would clobber a
    // newer state or resurrect a cleared task.
    const cur = this.activity.get(taskId)
    if (!cur || cur.at !== at) return

    if (this.stillWorking(live, at)) {
      cur.lapse = this.armLapse(taskId, at)
      return
    }

    this.publishIdle(taskId)
  }

  /**
   * Fold one OBSERVED per-session fact (issue #11/#16 — the activity
   * observer's PTY output heartbeat + foreground-walk reconciler) into the
   * per-tab record's OBSERVED slot. The hook slot is never mutated here;
   * what subscribers see follows {@link recomputeTabActivity}'s priority —
   * hook claims outrank observation except the one documented correction (a
   * stale hook `running` vs a fresher observed rest). Sticky attention
   * states are NEVER touched: they mean "a human is needed" and carry no
   * output by nature.
   *
   * Observed entries (including idle ones) are STORED so the subscribe-time
   * replay hands late clients the same known-idle facts; they carry no
   * lapse watchdog — the observer's own poll retires them.
   */
  observeTab(
    taskId: string,
    tabId: string,
    claim: "working" | "rest",
    opts: { vendor?: string; correctHookRunningAfterMs?: number } = {},
  ): ObserveTabOutcome {
    const tabs = this.tabActivity.get(taskId) ?? new Map<string, TabEntry>()
    const entry = tabs.get(tabId)
    const prev = entry?.effective
    const observed: ObservedSlot = {
      state: claim === "working" ? "running" : "idle",
      at: this.now(),
      vendor: opts.vendor ?? entry?.observed?.vendor ?? entry?.hook?.vendor,
    }
    const effective = recomputeTabActivity(
      { hook: entry?.hook, observed },
      observed.at,
      opts.correctHookRunningAfterMs ?? Number.POSITIVE_INFINITY,
    )
    if (!effective) return "noop" // unreachable — the observed slot was just written

    // Same state from the same source ⇒ a quiet refresh of the observed
    // slot's timestamp, no republish churn (a working engine re-asserted
    // every poll must not spam subscribers).
    if (prev && prev.state === effective.state && prev.source === effective.source) {
      if (entry) entry.observed = observed
      return "noop"
    }

    tabs.set(tabId, { hook: entry?.hook, observed, effective })
    this.tabActivity.set(taskId, tabs)
    this.bus.publish("engine-state", this.payload(taskId, effective, tabId))

    if (effective.source === "hook") return "noop" // the observation lost arbitration
    if (effective.state === "running") return "observed-running"
    return prev?.source === "hook" ? "corrected-hook-running" : "observed-idle"
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
        if (tabEntry.hook?.lapse) clearTimeout(tabEntry.hook.lapse)
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
    // per-tab map too. Hook-driven entries are only stored non-idle; the
    // OBSERVED slot includes known-idle ones on purpose — replaying them is
    // what lets a late client tell "known idle" from "no signal" (unknown).
    for (const [taskId, tabs] of this.tabActivity) {
      for (const [tabId, entry] of tabs) out.push(this.payload(taskId, entry.effective, tabId))
    }
    return out
  }

  /**
   * Raw diagnostic dump for `kobe api inspect` — every task/tab entry with
   * the fields the wire payload deliberately omits (probe vendor, whether a
   * lapse watchdog is armed, which source won the arbitration). Read-only;
   * production bug reports need to see what the registry ACTUALLY holds, not
   * the projected payload.
   */
  debugSnapshot(): {
    tasks: Record<string, { state: TaskActivityState; at: number; vendor?: string; lapseArmed: boolean }>
    tabs: Record<
      string,
      Record<
        string,
        {
          state: TaskActivityState
          at: number
          vendor?: string
          lapseArmed: boolean
          observed?: true
          source: "hook" | "observed"
        }
      >
    >
  } {
    const dump = (e: ActivityEntry) => ({
      state: e.state,
      at: e.at,
      ...(e.vendor ? { vendor: e.vendor } : {}),
      lapseArmed: e.lapse !== undefined,
    })
    const dumpTab = (e: TabEntry) => ({
      state: e.effective.state,
      at: e.effective.at,
      ...(e.effective.vendor ? { vendor: e.effective.vendor } : {}),
      ...(e.effective.source === "observed" ? { observed: true as const } : {}),
      lapseArmed: e.hook?.lapse !== undefined,
      source: e.effective.source,
    })
    const tasks: Record<string, ReturnType<typeof dump>> = {}
    for (const [taskId, entry] of this.activity) tasks[taskId] = dump(entry)
    const tabs: Record<string, Record<string, ReturnType<typeof dumpTab>>> = {}
    for (const [taskId, tabMap] of this.tabActivity) {
      const out: Record<string, ReturnType<typeof dumpTab>> = {}
      for (const [tabId, entry] of tabMap) out[tabId] = dumpTab(entry)
      tabs[taskId] = out
    }
    return { tasks, tabs }
  }

  close(): void {
    for (const entry of this.activity.values()) {
      if (entry.lapse) clearTimeout(entry.lapse)
    }
    for (const tabs of this.tabActivity.values()) {
      for (const entry of tabs.values()) {
        if (entry.hook?.lapse) clearTimeout(entry.hook.lapse)
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

  private payload(taskId: string, entry: PayloadSource, tabId?: string): EngineStatePayload {
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
