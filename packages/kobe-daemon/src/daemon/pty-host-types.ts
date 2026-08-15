/** PtyHost's public contract types — split from `pty-host.ts` for the
 *  file-size cap; behavior and ownership stay with the host. */

import type { StringDecoder } from "node:string_decoder"
import type { DaemonFrame, PtySessionExit } from "./protocol.ts"
import type { PtyChild, PtyDriver } from "./pty-driver.ts"
import type { PtyFreezeSink } from "./pty-freeze-store.ts"
import type { PtySessionEndInfo } from "./pty-observability.ts"

/** Everything `pty.open` needs to spawn a session's child on first open. */
export interface PtySpawnSpec {
  readonly cwd: string
  /** Explicit argv (engine sessions). Falls back to `shell`. */
  readonly command?: readonly string[]
  /** Shell override; defaults to `resolveLoginShell()`. */
  readonly shell?: string
  /** Absent = size-agnostic open (headless clients): a fresh spawn gets
   *  80×24 and a reattach NEVER resizes the session away from whatever
   *  client is attached to it. Only size-carrying opens (the TUI, which
   *  always sends its real pane size) take last-attach-wins. */
  readonly cols?: number
  readonly rows?: number
}

/** Attach result — mirrors the wire `PtyOpenResult`. */
export interface PtyAttachResult {
  readonly replay: string
  readonly alive: boolean
  /** The session child's pid (null when spawn failed) — see `PtyOpenResult.pid`. */
  readonly pid: number | null
  /** True when this open spawned/adopted the session — see `PtyOpenResult.created`. */
  readonly created: boolean
  /** True when this open RESPAWNED a freeze-restored corpse in place — the
   *  replay is the pre-restart scrollback and the child is new. See
   *  `PtyOpenResult.respawned`. */
  readonly respawned: boolean
  /** Monotonic byte offset at attach — see `PtyOpenResult.offset`. */
  readonly offset: number
  /** `replay` is the exact delta since the request's `sinceOffset` — see `PtyOpenResult.sinceValid`. */
  readonly sinceValid: boolean
}

/** Writes one event frame to an attached connection. */
export type PtySink = (frame: DaemonFrame) => void

/**
 * One hosted session's full mutable state. Lives here (not in pty-host.ts)
 * so the freeze store (`pty-freeze-store.ts`) can convert it to/from its
 * durable record without an import cycle.
 */
export interface PtySessionState {
  /** Mutable: warm-shell adoption re-keys the spare under the opener's key. */
  key: string
  readonly cwd: string
  proc: PtyChild | null
  alive: boolean
  chunks: Buffer[]
  bytes: number
  /** Total bytes the child has EVER written (monotonic — never reduced by
   *  ring trimming). `totalBytes - bytes` is the ring window's start
   *  offset; a detached client's recorded offset stays comparable across
   *  trims, which makes `sinceOffset` delta replays exact. */
  totalBytes: number
  cols: number
  rows: number
  /** Mutable: a freeze-restored session's respawn adopts the caller's
   *  launch (the TUI's dead-reattach passes its `--resume` argv). */
  command: readonly string[]
  title: string
  /** Unterminated escape tail carried between chunks for the title scan. */
  titleCarry: string
  /** UTF-8 decoder for the title scan (a multibyte title may split across chunks). */
  readonly titleDecoder: StringDecoder
  /** Attached connections, keyed by connection identity (the server's ClientState). */
  readonly sinks: Map<object, PtySink>
  /** A detached TUI still holds a serialized screen for an exact-delta wake. */
  parked: boolean
  parkedScreenBytes: number
  /** Death cause, recorded once by markExited; null while alive. */
  exit: PtySessionExit | null
  /** True between "rebuilt from a freeze record at host boot" and the first
   *  `open` that respawns it — the marker that separates a host-death
   *  casualty (respawn on attach) from an ordinary corpse (view only). */
  restored: boolean
  /** Freeze bookkeeping: output/exit drift since the last persisted snapshot. */
  lastFreezeAtMs: number
}

/** Durable-snapshot sink the host reports freezeable moments to. */
export type { PtyFreezeSink }

export interface PtyHostOptions {
  /** A session's child spawned — cancels a pending daemon idle-stop grace. */
  readonly onSessionStart?: () => void
  /** A session's child ended — may arm the idle-stop grace. */
  readonly onSessionEnd?: () => void
  /** Death record (exit status + output tail) per ended session — the
   *  durable-persistence hook. MUST be fail-safe; the host guards it. */
  readonly onSessionExit?: (info: PtySessionEndInfo) => void
  /** Freeze/restore sink (`pty-freeze-store.ts`). Absent = the pre-freeze
   *  behavior: session state dies with this process. */
  readonly freeze?: PtyFreezeSink
  /** Ring-buffer cap in bytes per session. Default 512KiB (`DEFAULT_SCROLLBACK_CAP`). */
  readonly scrollbackCap?: number
  /** How children spawn. Default Bun's; the Windows host injects node-pty's. */
  readonly driver?: PtyDriver
  readonly log?: (event: string, message: string) => void
}
