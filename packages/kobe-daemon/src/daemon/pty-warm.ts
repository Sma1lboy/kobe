/**
 * The warm-spare shell — split from `pty-host.ts` for the file-size cap.
 *
 * One pre-initialized spare shell (`pty.warm`) is kept OUTSIDE the host's
 * session map — invisible to `list`/`sweepTasks`/`liveCount` (it must not
 * pin the host open or be swept as an orphan). A matching `open` adopts it
 * under the opener's key and a replacement is warmed right away.
 * ponytail: single global slot keyed by cwd; per-worktree pools if
 * multi-repo warm hits matter.
 *
 * The host's own concerns (spawn/teardown/exit) arrive as deps, so this
 * class holds only the spare-slot policy.
 */

import { resolveLoginShell } from "./platform-shell.js"
import type { PtySessionState, PtySpawnSpec } from "./pty-host-types.ts"

export interface WarmSpareDeps {
  readonly spawn: (key: string, spec: PtySpawnSpec, spare: boolean) => PtySessionState
  readonly endChild: (session: PtySessionState) => Promise<void>
  readonly markExited: (session: PtySessionState) => void
  readonly log?: (event: string, message: string) => void
  readonly onSessionStart?: () => void
}

export class WarmSpare {
  private spare: PtySessionState | null = null

  constructor(private readonly deps: WarmSpareDeps) {}

  /**
   * Keep one idle shell pre-spawned for `cwd`. A live spare for the same
   * cwd+shell is kept; anything else is replaced (single slot — the most
   * recently warmed worktree wins). The spare deliberately skips
   * `onSessionStart` so it never cancels the host's idle-exit.
   */
  warm(cwd: string, shell?: string, cols = 80, rows = 24): void {
    const argv0 = shell ?? resolveLoginShell()
    if (this.spare?.alive && this.spare.cwd === cwd && this.spare.command[0] === argv0) return
    const old = this.spare
    this.spare = null
    if (old) void this.deps.endChild(old)
    const session = this.deps.spawn("::spare", { cwd, command: [argv0], cols, rows }, true)
    this.spare = session.alive ? session : null
  }

  /**
   * Hand the spare over to `open(key)` when it matches the spec: same
   * cwd, and the spec resolves to the spare's bare shell. The adopted
   * session becomes a REAL one (it now pins the host open) and a
   * replacement spare is warmed immediately.
   */
  adopt(key: string, spec: PtySpawnSpec): PtySessionState | null {
    const spare = this.spare
    if (!spare?.alive || spare.cwd !== spec.cwd) return null
    const want = spec.command && spec.command.length > 0 ? spec.command : [spec.shell ?? resolveLoginShell()]
    if (want.length !== 1 || want[0] !== spare.command[0]) return null
    this.spare = null
    spare.key = key
    // A size-less spec keeps the spare's dimensions (headless adopters
    // don't care; the first sized attach will resize).
    const cols = spec.cols ?? spare.cols
    const rows = spec.rows ?? spare.rows
    if (spare.cols !== cols || spare.rows !== rows) {
      spare.cols = cols
      spare.rows = rows
      try {
        spare.proc?.resize(cols, rows)
      } catch {
        this.deps.markExited(spare)
        return null
      }
    }
    this.deps.log?.("pty", `adopted warm shell for ${key} (pid ${spare.proc?.pid})`)
    this.deps.onSessionStart?.()
    this.warm(spec.cwd, spare.command[0], cols, rows)
    return spare
  }

  /** End the spare without adopting it (host teardown paths). */
  async end(): Promise<void> {
    const spare = this.spare
    this.spare = null
    if (spare) await this.deps.endChild(spare)
  }
}
