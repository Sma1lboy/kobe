import { worktreeInitMarkerPath } from "../env.ts"
import { quoteShellArg, quoteShellArgv } from "../lib/shell-command.ts"
import { type PromptDeliveryIntent, resolveEngineLaunchInit } from "../state/repo-init.ts"
import type { VendorId } from "../types/vendor.ts"
import { withDispatcherProtocol, withWorktreeProtocol } from "./interactive-command.ts"

export const SIGINT_GUARD = "trap ':' INT; "

/** Keep a hosted terminal useful after its engine exits. */
export function keepAlive(command: string): string {
  const banner = "\\n  ⚠ Engine exited (code %s). Check Settings → Engines and fix the launch command.\\n\\n"
  return `${command}; __rc=$?; [ "$__rc" -ne 0 ] && printf '${banner}' "$__rc"; exec "\${SHELL:-/bin/sh}"`
}

export interface EngineInitLaunch {
  readonly initScript?: string
  readonly markerPath?: string
  readonly timeoutSeconds?: number
}

export const REPO_INIT_TIMEOUT_SECONDS = 120
export const REPO_INIT_TIMEOUT_MIN_SECONDS = 5
export const REPO_INIT_TIMEOUT_MAX_SECONDS = 3600

export function resolveRepoInitTimeoutSeconds(raw?: string | number | null): number {
  const n = typeof raw === "number" ? raw : raw == null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return REPO_INIT_TIMEOUT_SECONDS
  return Math.max(REPO_INIT_TIMEOUT_MIN_SECONDS, Math.min(REPO_INIT_TIMEOUT_MAX_SECONDS, Math.round(n)))
}

/** Run repo init without allowing a hung setup command to block engine entry. */
function boundedInitGroup(script: string, timeoutSeconds: number): string {
  const seconds = String(timeoutSeconds)
  const timeoutBanner =
    "\\n  ⚠ Repo init (.kobe/init.sh) timed out after %ss and was killed; continuing to the engine.\\n\\n"
  const failBanner = "\\n  ⚠ Repo init (.kobe/init.sh) failed (code %s); continuing to the engine.\\n\\n"
  return [
    `__kobe_init_env="\${TMPDIR:-/tmp}/kobe-init-env.$$"`,
    `__kobe_init_to="\${TMPDIR:-/tmp}/kobe-init-timeout.$$"`,
    `rm -f "$__kobe_init_env" "$__kobe_init_to" 2>/dev/null`,
    "(",
    script,
    "__kobe_init_ec=$?",
    `export -p > "$__kobe_init_env" 2>/dev/null`,
    "exit $__kobe_init_ec",
    ") </dev/null &",
    "__kobe_init_pid=$!",
    `( sleep ${seconds}; : > "$__kobe_init_to"; kill -TERM "$__kobe_init_pid" 2>/dev/null; sleep 2; kill -KILL "$__kobe_init_pid" 2>/dev/null ) &`,
    "__kobe_init_wd=$!",
    `wait "$__kobe_init_pid" 2>/dev/null; __kobe_init_rc=$?`,
    `kill "$__kobe_init_wd" 2>/dev/null; wait "$__kobe_init_wd" 2>/dev/null`,
    `if [ -f "$__kobe_init_to" ]; then __kobe_init_rc=124; printf '${timeoutBanner}' '${seconds}';`,
    `elif [ "$__kobe_init_rc" -eq 0 ]; then [ -f "$__kobe_init_env" ] && . "$__kobe_init_env" 2>/dev/null;`,
    `else printf '${failBanner}' "$__kobe_init_rc"; fi`,
    `rm -f "$__kobe_init_env" "$__kobe_init_to" 2>/dev/null`,
  ].join("\n")
}

function markerDirOf(path: string): string {
  const index = path.lastIndexOf("/")
  return index <= 0 ? "." : path.slice(0, index)
}

/** Compose optional marker-gated repo init, engine command, and fallback shell. */
export function engineLaunchLine(engineCommand: string, init?: EngineInitLaunch): string {
  const tail = keepAlive(engineCommand)
  const script = init?.initScript?.trim()
  if (!script) return tail
  const group = boundedInitGroup(script, resolveRepoInitTimeoutSeconds(init?.timeoutSeconds))
  const markerPath = init?.markerPath
  if (!markerPath) return SIGINT_GUARD + [group, tail].join("\n")
  const marker = quoteShellArg(markerPath)
  const markerDir = quoteShellArg(markerDirOf(markerPath))
  return (
    SIGINT_GUARD +
    [
      `if [ ! -f ${marker} ]; then`,
      group,
      `if [ "$__kobe_init_rc" -eq 0 ]; then mkdir -p ${markerDir} && : > ${marker}; fi`,
      "fi",
      tail,
    ].join("\n")
  )
}

export interface EngineSessionLaunchTask {
  readonly id: string
  readonly kind?: "main" | "task"
  readonly vendor?: VendorId
  readonly repo?: string
}

export interface EngineSessionProtocolGates {
  readonly status?: () => boolean
  readonly notes?: () => boolean
  readonly dispatcher?: () => boolean
}

export interface EngineSessionLaunchInput {
  readonly task: EngineSessionLaunchTask
  readonly worktreePath: string
  readonly shell: string
  /** Engine argv with any tab-specific pin/resume flag already applied. */
  readonly argv: readonly string[]
  readonly promptIntent: PromptDeliveryIntent
  readonly initTimeoutSeconds?: number
  /** Injectable feature gates keep the pure composition deterministic in tests. */
  readonly protocolGates?: EngineSessionProtocolGates
}

export interface EngineSessionLaunch {
  readonly key: string
  readonly command: readonly string[]
}

/** Canonical PTY Host key for a task's first interactive engine tab. */
export function engineSessionKey(taskId: string): string {
  return `${taskId}::tab-1`
}

/** Build one PTY Host spawn spec shared by interactive and headless entry. */
export function buildEngineSessionLaunch(input: EngineSessionLaunchInput): EngineSessionLaunch {
  const protocolTaskId = input.task.kind === "main" ? undefined : input.task.id
  const dispatcherTaskId = input.task.kind === "main" ? input.task.id : undefined
  const gates = input.protocolGates
  const launchInit = resolveEngineLaunchInit(input.task.repo ?? "", input.worktreePath, input.promptIntent)
  let argv = withDispatcherProtocol(
    withWorktreeProtocol(input.argv, input.task.vendor, protocolTaskId, {
      status: gates?.status,
      notes: gates?.notes,
    }),
    input.task.vendor,
    dispatcherTaskId,
    gates?.dispatcher,
  )
  if (launchInit.firstMessage) argv = [...argv, launchInit.firstMessage.text]
  const script = engineLaunchLine(quoteShellArgv(argv, { bareSafe: true }), {
    initScript: launchInit.initScript,
    markerPath: launchInit.initScript ? worktreeInitMarkerPath(input.worktreePath) : undefined,
    timeoutSeconds: input.initTimeoutSeconds,
  })
  return { key: engineSessionKey(input.task.id), command: [input.shell, "-ilc", script] }
}
