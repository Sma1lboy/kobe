/**
 * Subprocess wrapper around the local `claude` CLI.
 *
 * Algorithm ported from `refs/opcode/src-tauri/src/commands/claude.rs`
 * lines 919–1014 (which build the args + spawn the command). We strip
 * Tauri/Tokio scaffolding and use Node's `child_process.spawn` (works
 * identically under Bun) — no PTY needed because stream-json speaks
 * line-delimited JSON over stdout, not terminal escape sequences.
 *
 * Args we pass:
 *   --output-format stream-json   line-by-line JSON event protocol
 *   --verbose                     required by `claude` for stream-json
 *   -p <prompt>                   the user's prompt
 *   --model <model>               optional, only when caller specifies
 *   --resume <sessionId>          set by `ClaudeCodeLocal.resume()`
 *
 * We deliberately do *not* set `--dangerously-skip-permissions`. opcode
 * does because it's a desktop GUI driving an unattended subprocess; we
 * are an interactive TUI and want the same permission prompts the user
 * would see if they ran `claude` themselves. (If a future stream needs
 * to override, pass it via `extraArgs`.)
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawn } from "node:child_process"
import type { Readable } from "node:stream"

/** Options for spawning a Claude Code subprocess. */
export interface SpawnClaudeOpts {
  /** Absolute path to the `claude` binary (from {@link findClaudeBinary}). */
  readonly binaryPath: string
  /** Working directory for the subprocess (typically a worktree root). */
  readonly cwd: string
  /** Prompt to pass via `-p`. May be a multi-line string. */
  readonly prompt: string
  /** Optional `--model <name>`. Omit to let `claude` pick its default. */
  readonly model?: string
  /** Optional `--resume <sessionId>`. Set by `ClaudeCodeLocal.resume()`. */
  readonly resumeSessionId?: string
  /** Optional `--permission-mode <mode>`. Forwarded verbatim from the orchestrator. */
  readonly permissionMode?: string
  /** Extra env vars merged on top of the inherited process env. */
  readonly env?: Readonly<Record<string, string>>
  /** Extra CLI args appended after the canonical set. Escape hatch for tests. */
  readonly extraArgs?: readonly string[]
}

/**
 * The handle returned by {@link spawnClaudeProcess}. Owns the running
 * child + its streams. Callers should pump `stdout` (typically through
 * {@link parseStreamJson}) and call `proc.kill()` to terminate.
 */
export interface SpawnedClaude {
  readonly proc: ChildProcessWithoutNullStreams
  readonly stdout: Readable
  readonly stderr: Readable
  readonly args: readonly string[]
}

/**
 * Spawn `claude -p <prompt> --output-format stream-json --verbose ...`
 * in the requested cwd. Returns synchronously once the OS has accepted
 * the fork — does NOT wait for the session to start streaming events.
 *
 * Errors at spawn time (binary not executable, ENOENT, EACCES) surface
 * via the returned process's `error` event; callers should attach a
 * one-shot listener if they care about distinguishing spawn failures
 * from "stream ended without a session id".
 */
export function spawnClaudeProcess(opts: SpawnClaudeOpts): SpawnedClaude {
  const args = buildArgs(opts)
  const proc = spawn(opts.binaryPath, args, {
    cwd: opts.cwd,
    // Inherit the parent's env so the user's shell-provided PATH /
    // NODE_PATH / NVM_BIN reach the child — opcode does the same in
    // `claude_binary::create_command_with_env`. We layer caller env on
    // top so explicit overrides win.
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams

  return {
    proc,
    stdout: proc.stdout,
    stderr: proc.stderr,
    args,
  }
}

/**
 * Build the canonical CLI args. Exposed for unit testing — keeps the
 * arg ordering pinned so we can assert against it without spawning.
 */
export function buildArgs(opts: SpawnClaudeOpts): string[] {
  const args: string[] = []
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId)
  }
  args.push("-p", opts.prompt)
  if (opts.model) {
    args.push("--model", opts.model)
  }
  if (opts.permissionMode) {
    args.push("--permission-mode", opts.permissionMode)
  }
  args.push("--output-format", "stream-json", "--verbose")
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs)
  }
  return args
}
