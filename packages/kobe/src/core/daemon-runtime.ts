/** Production Adapter for the daemon package's consumer-owned runtime seam. */

import type { DaemonRuntimeAdapter } from "@sma1lboy/kobe-daemon/daemon/runtime"
import { availableEngineIds } from "../engine/account-detect.ts"
import { isEngineActivityKind } from "../engine/hook-events.ts"
import { engineDisplayName, kobeApiInvocation } from "../engine/interactive-command.ts"
import { engineEntry } from "../engine/registry.ts"
import { createEngineTurnDetector } from "../engine/turn-detector.ts"
import { issueAssetsDir } from "../env.ts"
import { readOnlyGitProcessEnv } from "../lib/git-env.ts"
import { spawnCapture } from "../lib/poll-scheduling.ts"
import { latestTranscriptMtime } from "../monitor/activity.ts"
import { deriveTitleFromSession } from "../monitor/auto-title.ts"
import { GH_PR_VIEW_FIELDS, classifyGhFailure, mapGhPrView, nextPrPoll, samePrStatus } from "../monitor/pr-status.ts"
import { maybeAutoStart } from "../monitor/status-rules.ts"
import { type Orchestrator, PLACEHOLDER_TASK_TITLE } from "../orchestrator/core.ts"
import { getPersistedString, getSavedRepos, setPersistedString } from "../state/repos.ts"
import { runChatTabNamingPass } from "../tmux/chat-tab-naming.ts"
import { parsePorcelain } from "../tui/panes/sidebar/worktree-changes.ts"
import { DEFAULT_TASK_VENDOR, isTaskStatus } from "../types/task.ts"
import { CURRENT_VERSION, checkLatestVersion } from "../version.ts"
import { handleDiffRequest } from "../web/diff.ts"
import { handleHistoryRequest } from "../web/history.ts"
import { handleNotesRequest } from "../web/notes.ts"
import { handleThemesRequest } from "../web/themes.ts"
import {
  engineSpecAdapter,
  ensureTaskSessionAdapter,
  tearDownTaskSessionAdapter,
  terminalSpecAdapter,
} from "./daemon-session-adapter.ts"
import { daemonSettingsPatch, daemonSettingsSnapshot } from "./daemon-settings-adapter.ts"
import {
  handleWorktreesRequestAdapter,
  listWorktreeProjectsAdapter,
  removeWorktreeAdapter,
} from "./daemon-worktree-adapter.ts"

export const daemonRuntime: DaemonRuntimeAdapter = {
  currentVersion: CURRENT_VERSION,
  defaultTaskVendor: DEFAULT_TASK_VENDOR,
  placeholderTaskTitle: PLACEHOLDER_TASK_TITLE,
  isTaskStatus,
  isEngineActivityKind,
  checkLatestVersion,
  latestTranscriptMtime,
  deriveTitleFromSession,
  async runChatTabNamingPass(orch, schedule) {
    await runChatTabNamingPass(orch as Orchestrator, undefined, schedule as never)
  },
  createEngineTurnDetector,
  async runWorktreeStatus(worktreePath, signal) {
    const result = await spawnCapture("git", ["status", "--porcelain=v1"], {
      cwd: worktreePath,
      env: readOnlyGitProcessEnv(),
      signal,
    })
    if (result.status !== 0) throw new Error("git status failed")
    return parsePorcelain(result.stdout)
  },
  maybeAutoStart: (orch, taskId) => maybeAutoStart(orch as Orchestrator, taskId),
  listWorktreeProjects: listWorktreeProjectsAdapter,
  removeWorktree: removeWorktreeAdapter,
  availableEngineIds,
  engineDisplayName,
  kobeApiInvocation,
  engineEntry,
  engineSpec: engineSpecAdapter,
  terminalSpec: terminalSpecAdapter,
  ensureTaskSession: ensureTaskSessionAdapter,
  tearDownTaskSession: tearDownTaskSessionAdapter,
  settingsSnapshot: daemonSettingsSnapshot,
  settingsPatch: daemonSettingsPatch,
  handleDiffRequest,
  handleHistoryRequest,
  handleNotesRequest,
  handleThemesRequest,
  handleWorktreesRequest: handleWorktreesRequestAdapter,
  issueAssetsDir,
  getPersistedString,
  setPersistedString,
  getSavedRepos: () => [...getSavedRepos()],
  prStatus: {
    viewFields: GH_PR_VIEW_FIELDS,
    mapView: (view, at) => mapGhPrView(view as never, at),
    sameStatus: samePrStatus,
    nextPoll: (outcome, failures, now, config, random) =>
      nextPrPoll(outcome as never, failures, now, config as never, random),
    classify: classifyGhFailure,
  },
}
