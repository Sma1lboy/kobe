/** PtyHost's public contract types — split from `pty-host.ts` for the
 *  file-size cap; behavior and ownership stay with the host. */

import type { DaemonFrame } from "./protocol.ts"
import type { PtyDriver } from "./pty-driver.ts"
import type { PtySessionEndInfo } from "./pty-observability.ts"

/** Everything `pty.open` needs to spawn a session's child on first open. */
export interface PtySpawnSpec {
  readonly cwd: string
  /** Explicit argv (engine sessions). Falls back to `shell`. */
  readonly command?: readonly string[]
  /** Shell override; defaults to `resolveLoginShell()`. */
  readonly shell?: string
  readonly cols: number
  readonly rows: number
}

/** Attach result — mirrors the wire `PtyOpenResult`. */
export interface PtyAttachResult {
  readonly replay: string
  readonly alive: boolean
  /** The session child's pid (null when spawn failed) — see `PtyOpenResult.pid`. */
  readonly pid: number | null
  /** True when this open spawned/adopted the session — see `PtyOpenResult.created`. */
  readonly created: boolean
  /** Monotonic byte offset at attach — see `PtyOpenResult.offset`. */
  readonly offset: number
  /** `replay` is the exact delta since the request's `sinceOffset` — see `PtyOpenResult.sinceValid`. */
  readonly sinceValid: boolean
}

/** Writes one event frame to an attached connection. */
export type PtySink = (frame: DaemonFrame) => void

export interface PtyHostOptions {
  /** A session's child spawned — cancels a pending daemon idle-stop grace. */
  readonly onSessionStart?: () => void
  /** A session's child ended — may arm the idle-stop grace. */
  readonly onSessionEnd?: () => void
  /** Death record (exit status + output tail) per ended session — the
   *  durable-persistence hook. MUST be fail-safe; the host guards it. */
  readonly onSessionExit?: (info: PtySessionEndInfo) => void
  /** Ring-buffer cap in bytes per session. Default 512KiB (`DEFAULT_SCROLLBACK_CAP`). */
  readonly scrollbackCap?: number
  /** How children spawn. Default Bun's; the Windows host injects node-pty's. */
  readonly driver?: PtyDriver
  readonly log?: (event: string, message: string) => void
}
