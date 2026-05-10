/**
 * PTY-based driver for behavior tests.
 *
 * Spawns the kobe binary inside a PTY, captures the screen as raw
 * bytes, and exposes a tiny synchronous-feeling API for tests:
 *
 *   const k = await spawnKobe()
 *   await k.waitFor((s) => s.includes("kobe"))
 *   await k.sendKeys("q")
 *   await k.exit()
 *
 * Implementation notes:
 *
 *   - We use `node-pty` because Bun's built-in spawn does NOT
 *     allocate a pty for the child, and the kobe TUI requires one
 *     (opentui early-exits when stdout isn't a tty). vitest itself
 *     runs under Node (its bin shebang is `#!/usr/bin/env node`),
 *     so importing `node-pty` from a `*.test.ts` file is safe even
 *     though the rest of the project runs under Bun.
 *
 *   - The kobe binary IS spawned via `bun` — that part doesn't
 *     change. We build the command line that matches the `dev`
 *     script in `package.json` (do not re-shell through `bun run dev`
 *     because `bun run` may not propagate the pty cleanly).
 *
 *   - On macOS arm64, Bun's installer ships node-pty's prebuilt
 *     `spawn-helper` without an exec bit (postinstall script doesn't
 *     chmod). We fix that lazily on first spawn — see
 *     `ensureSpawnHelperExecutable`. Without this fix the very first
 *     `pty.spawn()` after `bun install` throws `posix_spawnp failed`.
 *
 *   - `capture()` strips ANSI via `./screen.ts` so assertions read
 *     plain text. The raw byte buffer is also exposed via
 *     `captureRaw()` for tests that need to assert on escape codes.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as pty from "node-pty"
import { normalizeScreen } from "./screen"

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Root of THIS package (`packages/kobe/`). Use for src/test paths. */
const PACKAGE_ROOT = path.resolve(HERE, "..", "..")
/**
 * Root of the monorepo (two levels above `packages/kobe/`). Bun
 * workspaces hoist `node_modules` here, so any check that needs the
 * resolved on-disk location of a dependency goes through this root,
 * not the package root. Falls back to the package root for legacy
 * single-package callers (the `node_modules` lookup below tries
 * monorepo root first, then package root).
 */
const MONOREPO_ROOT = path.resolve(HERE, "..", "..", "..", "..")

/** Default PTY size — matches a typical 80x24 terminal. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** Time to wait after a `sendKeys` before considering the screen settled. */
const DEFAULT_SETTLE_MS = 100

/** How long `waitFor` polls before giving up. */
const DEFAULT_TIMEOUT_MS = 5_000

/** Grace period between SIGTERM and SIGKILL during teardown. */
const EXIT_GRACE_MS = 750

export interface SpawnKobeOpts {
  /** Working directory for the spawned kobe process. Defaults to repo root. */
  cwd?: string
  /** Override argv. By default we run kobe's CLI entry via Bun. */
  command?: string
  args?: string[]
  /** PTY columns. Default 80. */
  cols?: number
  /** PTY rows. Default 24. */
  rows?: number
  /** Extra env vars merged on top of `process.env`. */
  env?: Record<string, string>
  /** ms to wait after each `sendKeys` for the screen to repaint. */
  settleMs?: number
}

export interface KobeHandle {
  /** Send raw bytes to the kobe stdin. Useful for control codes. */
  sendKeys(seq: string): Promise<void>
  /** Higher-level: send a string of text + (optional) trailing key. */
  typeText(s: string): Promise<void>
  /** Plain-text snapshot of the visible screen (ANSI stripped, normalized). */
  capture(): Promise<string>
  /** Raw byte buffer received from the pty since spawn. ANSI included. */
  captureRaw(): string
  /**
   * Poll `capture()` every ~50ms until `predicate(screen)` is true or
   * `timeoutMs` elapses. Throws on timeout — the message includes the
   * last screen so failures are debuggable.
   */
  waitFor(predicate: (screen: string) => boolean, timeoutMs?: number): Promise<string>
  /** Resize the PTY to `cols x rows`. Triggers a SIGWINCH-equivalent. */
  resize(cols: number, rows: number): void
  /** Tear down: SIGTERM, then SIGKILL after a short grace. Idempotent. */
  exit(): Promise<void>
  /** Has the underlying pty exited? */
  readonly closed: boolean
  /** The exit code, once available. `null` while running or killed mid-flight. */
  readonly exitCode: number | null
}

/**
 * Some Bun installs ship node-pty's prebuilt spawn-helper without an
 * exec bit. Fix it once per process. No-op on platforms that don't
 * ship a spawn-helper (Windows, etc.).
 */
function ensureSpawnHelperExecutable(): void {
  // Resolve `node-pty`'s on-disk location. Try monorepo root first
  // (Bun workspaces hoist deps there), then this package's local
  // node_modules (legacy / single-package layout).
  let npPkg = path.join(MONOREPO_ROOT, "node_modules", "node-pty")
  if (!fs.existsSync(npPkg)) npPkg = path.join(PACKAGE_ROOT, "node_modules", "node-pty")
  if (!fs.existsSync(npPkg)) return // not installed in this worktree
  const arch = `${process.platform}-${process.arch}`
  const helper = path.join(npPkg, "prebuilds", arch, "spawn-helper")
  if (!fs.existsSync(helper)) return
  try {
    const st = fs.statSync(helper)
    // 0o111 = any exec bit
    if ((st.mode & 0o111) === 0) {
      fs.chmodSync(helper, st.mode | 0o755)
    }
  } catch {
    // Best-effort. If it fails, the spawn will throw a clearer error.
  }
}

/**
 * Default kobe argv: invoke `bun` with the same flags as `bun run dev`,
 * pointing at the CLI entry. Resolved relative to `cwd` so callers can
 * point at a different repo if they ever need to.
 */
function defaultCommand(cwd: string): { command: string; args: string[] } {
  return {
    command: "bun",
    args: ["--preload", "@opentui/solid/preload", "--conditions=browser", path.join(cwd, "src", "cli", "index.ts")],
  }
}

export async function spawnKobe(opts: SpawnKobeOpts = {}): Promise<KobeHandle> {
  ensureSpawnHelperExecutable()

  const cwd = opts.cwd ?? PACKAGE_ROOT
  const cols = opts.cols ?? DEFAULT_COLS
  const rows = opts.rows ?? DEFAULT_ROWS
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS
  const { command, args } =
    opts.command !== undefined ? { command: opts.command, args: opts.args ?? [] } : defaultCommand(cwd)

  // Filter `process.env` down to string-only entries (node-pty's typings
  // require `Record<string, string>`, while `process.env` is
  // `Record<string, string | undefined>`).
  const baseEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v
  }

  const env: Record<string, string> = {
    ...baseEnv,
    // Many TUIs render plain ASCII unless the term advertises 256color.
    TERM: "xterm-256color",
    COLUMNS: String(cols),
    LINES: String(rows),
    // Discourage interactive prompts from any tool spawned beneath kobe.
    CI: "1",
    ...(opts.env ?? {}),
  }

  const term = pty.spawn(command, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
  })

  let buffer = ""
  let closed = false
  let exitCode: number | null = null

  term.onData((chunk) => {
    buffer += chunk
    // Cap buffer growth at ~1 MB; behavior tests should be short.
    if (buffer.length > 1_000_000) {
      buffer = buffer.slice(-500_000)
    }
  })

  term.onExit(({ exitCode: code }) => {
    closed = true
    exitCode = code ?? null
  })

  /** Wait for `ms` milliseconds. */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  const handle: KobeHandle = {
    async sendKeys(seq) {
      if (closed) throw new Error("kobe pty is closed")
      term.write(seq)
      await sleep(settleMs)
    },
    async typeText(s) {
      if (closed) throw new Error("kobe pty is closed")
      term.write(s)
      await sleep(settleMs)
    },
    async capture() {
      return normalizeScreen(buffer)
    },
    captureRaw() {
      return buffer
    },
    async waitFor(predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs
      let last = ""
      while (Date.now() < deadline) {
        last = normalizeScreen(buffer)
        if (predicate(last)) return last
        await sleep(50)
      }
      throw new Error(`waitFor: predicate not met within ${timeoutMs}ms. Last screen:\n${last || "(empty)"}`)
    },
    resize(c, r) {
      if (!closed) term.resize(c, r)
    },
    async exit() {
      if (closed) return
      try {
        term.kill("SIGTERM")
      } catch {
        // already dead
      }
      const deadline = Date.now() + EXIT_GRACE_MS
      while (!closed && Date.now() < deadline) {
        await sleep(25)
      }
      if (!closed) {
        try {
          term.kill("SIGKILL")
        } catch {
          // already dead
        }
        // Give onExit one more tick to fire.
        for (let i = 0; i < 20 && !closed; i++) await sleep(25)
      }
    },
    get closed() {
      return closed
    },
    get exitCode() {
      return exitCode
    },
  }

  return handle
}
