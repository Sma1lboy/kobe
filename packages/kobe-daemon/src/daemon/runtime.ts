import type { DaemonRpcClient } from "../client/rpc.ts"
import type {
  DaemonOrchestrator,
  DaemonTask,
  EngineActivityKind,
  UpdateInfo,
  VendorId,
  WorktreeChanges,
} from "./contracts.ts"

export interface EngineTurnDetectorAdapter {
  latestActivity(worktreePath: string): Promise<{
    marker: { id: string; timestampMs: number } | null
    mtimeMs: number
  }>
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
  checkLatestVersion(): Promise<UpdateInfo | null>
  latestTranscriptMtime(vendor: VendorId, worktreePath: string): Promise<number>
  deriveTitleFromSession(worktreePath: string, vendor: VendorId): Promise<string>
  runChatTabNamingPass(orch: DaemonOrchestrator, schedule: Map<string, unknown>): Promise<unknown>
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
  tearDownTaskSession(taskId: string): Promise<void>
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
