/**
 * Freeze/restore persistence for hosted PTY sessions.
 *
 * The host keeps every session's scrollback ring in memory, so the host
 * process ending (crash, machine reboot, SIGTERM) used to take the whole
 * work scene with it: dead children are expected, but the session table
 * and every byte of scrollback evaporated too, and the next host came up
 * knowing nothing. This store is the freeze half of the fix: one small
 * JSON file per session under `<home>/.kobe/pty-sessions/`, holding
 * everything a LATER host incarnation needs to put the session back —
 * metadata (key, cwd, launch command, size, title, byte offsets) plus the
 * ring buffer itself.
 *
 * Restore is LAZY and lossy-by-design: a thawed session comes back as a
 * dead "restored" corpse with its scrollback intact, and the first
 * `pty.open` respawns the child in place (see `pty-host.ts`). Nothing
 * pretends a dead process can be resurrected — the contract is "your
 * screen and your launch line survive the host, your conversation
 * survives via the engine's own resume".
 *
 * Write discipline: atomic tmp+rename per session file, everything
 * best-effort (a freeze hiccup must never take the terminal down), one
 * file per session so a flush rewrites only what drifted. Explicitly
 * killed sessions (`pty.kill`, the archive sweep) drop their record — a
 * close the user asked for is not a restart casualty. `rove reset`'s
 * graceful stop clears the whole directory ("starts fresh" is reset's
 * contract); a bare SIGTERM / crash / reboot leaves it for the next host.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { defaultPtyFreezeDir } from "./paths.ts"
import type { PtySessionExit } from "./protocol.ts"
import type { PtySessionState } from "./pty-host-types.ts"

/** Record format version — unknown versions read as absent (forward-safe). */
const FREEZE_VERSION = 1

/** One session, frozen. The ring rides base64; offsets stay monotonic. */
export interface FrozenPtySession {
  readonly v: number
  readonly key: string
  readonly cwd: string
  readonly command: readonly string[]
  readonly cols: number
  readonly rows: number
  readonly title: string
  /** Same monotonic total the live session tracked — restored sessions
   *  continue it, so a client's parked offset stays comparable. */
  readonly totalBytes: number
  /** How the child died when it did; null for a host-death casualty. */
  readonly exit: PtySessionExit | null
  readonly ringB64: string
  readonly updatedAt: string
}

/** Durable-snapshot sink `PtyHost` reports freezeable moments to. */
export interface PtyFreezeSink {
  save(record: FrozenPtySession): void
  drop(key: string): void
}

/** The session fields a snapshot needs (structural — `PtySessionState`
 *  satisfies it, tests can fake it). */
export interface FreezeableSession {
  readonly key: string
  readonly cwd: string
  readonly command: readonly string[]
  readonly cols: number
  readonly rows: number
  readonly title: string
  readonly totalBytes: number
  readonly exit: PtySessionExit | null
  readonly chunks: readonly Buffer[]
  readonly bytes: number
}

/** Session state → its durable record. Pure. */
export function freezeSession(session: FreezeableSession, now = new Date()): FrozenPtySession {
  return {
    v: FREEZE_VERSION,
    key: session.key,
    cwd: session.cwd,
    command: [...session.command],
    cols: session.cols,
    rows: session.rows,
    title: session.title,
    totalBytes: session.totalBytes,
    exit: session.exit,
    ringB64: Buffer.concat(session.chunks as Buffer[]).toString("base64"),
    updatedAt: now.toISOString(),
  }
}

/**
 * Record → ring buffers, trimmed to `cap` bytes from the FRONT (the tail
 * is what a reattach repaints). Returns null for a malformed ring. A newer
 * host with a smaller cap than the freezing host still restores safely.
 */
export function thawRing(record: FrozenPtySession, cap: number): { chunks: Buffer[]; bytes: number } | null {
  let ring: Buffer
  try {
    ring = Buffer.from(record.ringB64, "base64")
  } catch {
    return null
  }
  const trimmed = ring.byteLength > cap ? ring.subarray(ring.byteLength - cap) : ring
  return { chunks: trimmed.byteLength > 0 ? [trimmed] : [], bytes: trimmed.byteLength }
}

/**
 * Record → a restored session state: dead, ring intact, marked `restored`
 * so the host's next `open` respawns the child in place instead of treating
 * it as a view-only corpse. Null for a malformed ring.
 */
export function thawSession(record: FrozenPtySession, cap: number): PtySessionState | null {
  const ring = thawRing(record, cap)
  if (!ring) return null
  return {
    key: record.key,
    cwd: record.cwd,
    proc: null,
    alive: false,
    chunks: [...ring.chunks],
    bytes: ring.bytes,
    totalBytes: Math.max(record.totalBytes, ring.bytes),
    cols: record.cols,
    rows: record.rows,
    command: record.command,
    title: record.title,
    titleCarry: "",
    titleDecoder: new StringDecoder("utf8"),
    sinks: new Map(),
    parked: false,
    parkedScreenBytes: 0,
    exit: record.exit,
    restored: true,
    lastFreezeAtMs: 0,
  }
}

/** `taskId::tab-1` → a filename every filesystem tolerates. */
function recordFile(dir: string, key: string): string {
  return join(dir, `${encodeURIComponent(key)}.json`)
}

function parseRecord(raw: string): FrozenPtySession | null {
  try {
    const parsed = JSON.parse(raw) as FrozenPtySession
    if (parsed?.v !== FREEZE_VERSION) return null
    if (typeof parsed.key !== "string" || parsed.key.length === 0) return null
    if (parsed.key.startsWith("::")) return null // internal keys never freeze
    if (typeof parsed.cwd !== "string" || !Array.isArray(parsed.command)) return null
    if (typeof parsed.ringB64 !== "string" || typeof parsed.totalBytes !== "number") return null
    return parsed
  } catch {
    return null
  }
}

/** Every restorable record in `dir`; missing/corrupt entries read as none. */
export function loadFrozenSessions(dir = defaultPtyFreezeDir()): FrozenPtySession[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: FrozenPtySession[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const record = parseRecord(readFileSync(join(dir, name), "utf8"))
      if (record) out.push(record)
    } catch {
      // One unreadable file must not cost the rest.
    }
  }
  return out
}

/** The real sink: per-session atomic files under `dir`. Never throws. */
export function fileFreezeSink(dir = defaultPtyFreezeDir()): PtyFreezeSink {
  return {
    save(record) {
      try {
        mkdirSync(dir, { recursive: true })
        const target = recordFile(dir, record.key)
        const staging = `${target}.${process.pid}.tmp`
        writeFileSync(staging, JSON.stringify(record), "utf8")
        renameSync(staging, target)
      } catch {
        /* best-effort by contract — a freeze hiccup never kills the terminal */
      }
    },
    drop(key) {
      try {
        rmSync(recordFile(dir, key), { force: true })
      } catch {
        /* absent is the desired end state anyway */
      }
    },
  }
}

/**
 * Wipe every frozen session — `rove reset`'s graceful pty-host stop only.
 * An explicit teardown is not a restart: the next host must come up empty,
 * not resurrect sessions reset was asked to end.
 */
export function clearFrozenSessions(dir = defaultPtyFreezeDir()): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* already gone */
  }
}
