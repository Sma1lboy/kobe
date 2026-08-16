/**
 * Foreground-process identity for a terminal tab — "what engine is
 * actually running in this shell right now", answered from the process
 * tree instead of the OSC window title.
 *
 * The title was the old signal (`vendorFromTerminalTitle`) and it is
 * structurally wrong: an engine's title is free-form activity text it
 * writes for HUMANS ("✳ Claude Code" at launch, then a summary of what
 * it's doing), so a claude session whose summary happened to mention
 * "codex" identified as codex — a substring collision, not an identity.
 *
 * A process tree can't collide like that: we walk the PTY shell's
 * descendants and ask each one's ARGV[0] (the executable, never its
 * arguments) whether it is a registered engine binary. That also sees
 * through user wrappers — `claudecpa` is a zsh function running
 * `cc-switch start claude …`, whose own argv[0] is `cc-switch`, but its
 * child is the real `claude.exe`, and the walk keeps going.
 */

import { basename } from "node:path"
import { BUILTIN_VENDORS, type VendorId } from "../types/vendor"
import { engineEntry } from "./registry"

/** One line of `ps -A -o pid=,ppid=,args=`. */
export type ProcRow = {
  readonly pid: number
  readonly ppid: number
  /** Full command line, argv joined by spaces (what `ps` prints). */
  readonly args: string
}

/** The live engine found running inside a tab's shell. */
export type ForegroundEngine = {
  readonly vendor: VendorId
  /** The command line as `ps` reports it — replayed on restart. */
  readonly argv: string
  readonly pid: number
}

/**
 * Interpreters/launchers that are never the identity themselves: their
 * argv[0] says nothing, the interesting name is the next token (`node
 * …/codex.js`) or a child process (`env FOO=1 claude`).
 */
const WRAPPERS = new Set(["node", "bun", "npx", "deno", "sh", "zsh", "bash", "env", "script"])

/** Strip the launcher suffixes a binary may carry (`claude.exe`). */
function binaryName(token: string): string {
  return basename(token).replace(/\.(exe|js|mjs|cjs)$/, "")
}

/**
 * The vendor a command line IS, or null. Only the executable position
 * counts — scanning arguments is what made the title heuristic wrong
 * (`cc-switch start claude …` is cc-switch, not claude; its claude CHILD
 * is what identifies, and the tree walk finds that one).
 */
export function vendorFromArgv(commandLine: string): VendorId | null {
  for (const token of commandLine.trim().split(/\s+/).slice(0, 4)) {
    // `env FOO=1 claude` — the assignments sit between wrapper and binary.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    const name = binaryName(token)
    if (WRAPPERS.has(name)) continue
    // defaultCommand[0] is the launch binary; processNames covers engines
    // that rewrite their process title post-launch (kimi → `kimi-co`).
    return (
      BUILTIN_VENDORS.find((v) => {
        const entry = engineEntry(v)
        return entry.defaultCommand[0] === name || entry.processNames?.includes(name) === true
      }) ?? null
    )
  }
  return null
}

/** Parse `ps -A -o pid=,ppid=,args=` output; unparsable lines are skipped. */
export function parsePsSnapshot(text: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] })
  }
  return rows
}

function childrenIndex(rows: readonly ProcRow[]): Map<number, ProcRow[]> {
  const kids = new Map<number, ProcRow[]>()
  for (const row of rows) {
    const list = kids.get(row.ppid)
    if (list) list.push(row)
    else kids.set(row.ppid, [row])
  }
  return kids
}

/**
 * Is `ancestorPid` anywhere on `pid`'s parent chain (or `pid` itself)?
 *
 * The lineage half of "am I really running inside this tab" (issue #24):
 * `$KOBE_TASK_ID` is an ordinary env var and inherits down the whole
 * process tree, so a background daemon forked out of an engine tab keeps
 * that identity for as long as it lives. A pid chain can't be inherited —
 * a process that detached (ppid reparented to 1) simply stops reaching the
 * tab's shell, which is exactly the case we must refuse.
 *
 * The walk is bounded by the row count: a `ps` snapshot is a forest, but a
 * malformed/racy one could still hand us a ppid cycle.
 */
export function hasAncestor(rows: readonly ProcRow[], pid: number, ancestorPid: number): boolean {
  const parents = new Map(rows.map((r) => [r.pid, r.ppid]))
  let cur = pid
  for (let hops = 0; hops <= rows.length; hops++) {
    if (cur === ancestorPid) return true
    const next = parents.get(cur)
    if (next === undefined || next <= 1) return false
    cur = next
  }
  return false
}

/**
 * Breadth-first hunt for an engine among `rootPid`'s descendants —
 * shallowest wins, so a wrapper's engine child is found before that
 * engine's own helper processes (claude spawns `claude bg-pty-host`
 * subprocesses; the session itself is nearer the shell).
 */
export function foregroundEngineIn(rows: readonly ProcRow[], rootPid: number): ForegroundEngine | null {
  const kids = childrenIndex(rows)
  const queue = [...(kids.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const row = queue.shift()
    if (!row) break
    const vendor = vendorFromArgv(row.args)
    if (vendor) return { vendor, argv: row.args, pid: row.pid }
    queue.push(...(kids.get(row.pid) ?? []))
  }
  return null
}

/**
 * Is ANY engine process running under `rootPid`? The delivery gate's
 * question (herdr's "agent is no longer the pane foreground process"):
 * kobe's keepAlive wrapper keeps a tab's PTY alive after its engine exits,
 * so "session alive" never proves an engine is there — and pasting a prompt
 * into the fallback SHELL executes it as commands. Vendor-agnostic on
 * purpose: any engine may receive text (cross-vendor send is legitimate);
 * only a bare shell must not. `extraBin` matches a custom engine's launch
 * binary by name — a user-registered engine (aider etc.) is not a builtin,
 * so the argv walk alone can't see it.
 */
export function engineProcessIn(rows: readonly ProcRow[], rootPid: number, extraBin?: string): boolean {
  if (foregroundEngineIn(rows, rootPid)) return true
  if (!extraBin) return false
  const kids = childrenIndex(rows)
  const queue = [...(kids.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const row = queue.shift()
    if (!row) break
    const argv0 = row.args.trim().split(/\s+/)[0] ?? ""
    if (basename(argv0) === extraBin) return true
    queue.push(...(kids.get(row.pid) ?? []))
  }
  return false
}

/** Injectable so tests never shell out. */
export type PsSnapshot = () => Promise<string>

export const psSnapshot: PsSnapshot = async () => {
  const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,args="], { stdout: "pipe", stderr: "ignore" })
  return await new Response(proc.stdout).text()
}

/**
 * The engine running under `rootPid` (a tab's PTY shell), or null when
 * the shell is just sitting at its prompt. Null on any `ps` failure —
 * an identity we can't read is "no engine", never a guess.
 */
export async function foregroundEngine(
  rootPid: number,
  snapshot: PsSnapshot = psSnapshot,
): Promise<ForegroundEngine | null> {
  try {
    return foregroundEngineIn(parsePsSnapshot(await snapshot()), rootPid)
  } catch {
    return null
  }
}
