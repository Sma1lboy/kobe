import type { DaemonRpcClient } from "../client/rpc.ts"
import type {
  DaemonOrchestrator,
  DaemonTask,
  EngineActivityKind,
  EngineQuotaUsage,
  UpdateInfo,
  VendorId,
  WorktreeChanges,
} from "./contracts.ts"

export interface EngineTurnDetectorAdapter {
  latestActivity(worktreePath: string): Promise<{
    marker: { id: string; timestampMs: number } | null
    mtimeMs: number
  }>
  /** {@link latestActivity} scoped to one session transcript; `null` = not
   *  supported by this vendor (or file gone) — fall back to the worktree scan. */
  latestActivityInFile(transcriptPath: string): Promise<{
    marker: { id: string; timestampMs: number } | null
    mtimeMs: number
  } | null>
  supportsCompletionMarkers(): boolean
}

export interface PollCadenceConfig {
  readonly timeoutMs: number
  readonly slowRetryMs: number
  readonly minIntervalMs: number
}

export interface PollScheduleState {
  inFlight: boolean
  nextAllowedAt: number
}

export interface DaemonRuntimeAdapter {
  readonly currentVersion: string
  readonly defaultTaskVendor: VendorId
  readonly placeholderTaskTitle: string
  isTaskStatus(value: unknown): value is DaemonTask["status"]
  isEngineActivityKind(value: string): value is EngineActivityKind
  /** True for kinds that change the activity badge state; false for
   *  lifecycle-only kinds (tool/compact/subagent) that only feed plugins. */
  affectsActivityState(value: string): boolean
  /**
   * Foreground engine per session root pid — ONE `ps` snapshot walked per
   * pid (kobe's `engine/foreground.ts`, the same primitive `kobe api
   * inspect` uses). Vendor id, or null for "no engine in this tree".
   * Consumed by the daemon activity observer's reconciler (issues #11/#16).
   */
  foregroundEngines(pids: readonly number[]): Promise<ReadonlyMap<number, VendorId | null>>
  /**
   * Engine-owned verdict on a live OSC title (`engineTitleTurnHint`):
   * "working" while the vendor's animated frame prefixes it, "rest" when a
   * status-owning vendor wrote a title without one, null when the vendor
   * declares no vocabulary (or the title is empty) — never guessed.
   */
  titleTurnHint(vendor: VendorId, title: string): "working" | "rest" | null
  checkLatestVersion(): Promise<UpdateInfo | null>
  latestTranscriptMtime(vendor: VendorId, worktreePath: string): Promise<number>
  deriveTitleFromSession(worktreePath: string, vendor: VendorId): Promise<string>
  createEngineTurnDetector(vendor: VendorId): EngineTurnDetectorAdapter
  runWorktreeStatus(worktreePath: string, signal: AbortSignal): Promise<WorktreeChanges>
  maybeAutoStart(orch: DaemonOrchestrator, taskId: string): Promise<string>
  listWorktreeProjects(network: boolean): Promise<unknown[]>
  removeWorktree(path: string, force: boolean): Promise<void>
  availableEngineIds(): Promise<readonly VendorId[]>
  engineDisplayName(vendor: VendorId): string
  kobeApiInvocation(): string
  engineSpec(link: DaemonRpcClient, taskId: string): Promise<{ cwd: string; command: string[] }>
  terminalSpec(link: DaemonRpcClient, taskId: string): Promise<{ cwd: string; command: string[] }>
  ensureTaskSession(link: DaemonRpcClient, taskId: string): Promise<{ session: string; worktreePath: string }>
  /**
   * Materialize a task's worktree and START its engine with `prompt` as the
   * launch-time first message. Returns false when the session did not come up.
   *
   * The spawning sibling of {@link deliverPromptToLiveEngine}, which exists for
   * the opposite case (resume a session that is already alive, never spawn).
   * An automation run has no prior session by construction, so it needs this
   * one. The prompt rides the engine's own argv rather than being typed into
   * the PTY afterwards — a cold engine can swallow a raced paste, and an
   * unattended run has nobody watching to notice.
   */
  startTaskSessionWithPrompt(link: DaemonRpcClient, taskId: string, prompt: string): Promise<boolean>
  tearDownTaskSession(taskId: string): Promise<void>
  /**
   * Engine-owned subscription-quota probe: snapshot of the vendor account's
   * usage windows, or null when unknowable (no login, no quota API, network
   * failure). The probe hits the vendor's own rate-limited API — ONLY the
   * daemon's QuotaUsageCache may call this; everything else reads the cache.
   */
  quotaUsage(vendor: VendorId): Promise<EngineQuotaUsage | null>
  /**
   * Vendors whose adapter ships a quota probe at all. Quota is ACCOUNT-level,
   * so the usage poller walks this list rather than the vendors currently in
   * play across tasks — otherwise an engine the user is logged into but has
   * no open task for never gets asked, and its balance silently never shows.
   */
  vendorsWithQuotaProbe(): readonly VendorId[]
  /**
   * Deliver a prompt into a task's LIVE hosted engine session only (never
   * spawns). Returns false when no alive engine session exists.
   */
  deliverPromptToLiveEngine(
    task: {
      readonly id: string
      readonly vendor?: VendorId
      /** Raw launch command pinned on the task; wins over `vendor` when set. */
      readonly command?: string
      readonly worktreePath: string
    },
    prompt: string,
  ): Promise<boolean>
  settingsSnapshot(): Response
  settingsPatch(request: Request): Promise<Response>
  handleDiffRequest(request: Request, url: URL): Promise<Response | null>
  handleHistoryRequest(request: Request, url: URL): Promise<Response | null>
  handleNotesRequest(request: Request, url: URL): Promise<Response | null>
  handleThemesRequest(request: Request, url: URL): Response | null
  handleWorktreesRequest(request: Request, url: URL): Promise<Response | null>
  issueAssetsDir(): string
  getPersistedString(key: string): string | undefined
  setPersistedString(key: string, value: string): void
  getSavedRepos(): readonly string[]
  engineEntry(vendor: VendorId): { effortLevels?: readonly string[] }
  prStatus: {
    /** The `--json` field set `gh pr view`/`gh pr list` request — single source
     * for the daemon's `gh` calls and the pure mapper's expected shape. */
    viewFields: string
    mapView(view: unknown, at: string): NonNullable<DaemonTask["prStatus"]> | null
    sameStatus(a: DaemonTask["prStatus"] | null, b: DaemonTask["prStatus"] | null): boolean
    nextPoll(
      outcome: unknown,
      failures: number,
      now: number,
      config: unknown,
      random?: () => number,
    ): {
      nextAllowedAt: number
      failures: number
    }
    /** Classify a non-success `gh` run into a typed transport/tooling error.
     * Pure — see `monitor/pr-status.ts`. "No PR" is never inferred here; it's
     * a structural empty-array SUCCESS the caller detects before falling back
     * to this classifier. */
    classify(signals: {
      spawnError?: boolean
      timedOut?: boolean
      exitCode?: number | null
      stderr?: string
      parseError?: boolean
    }): { kind: "error"; error: string }
  }
}
