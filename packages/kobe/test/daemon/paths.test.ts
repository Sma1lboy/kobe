/**
 * Unit tests for daemon socket / pid path resolution.
 *
 * Load-bearing rule: an explicit `KOBE_HOME_DIR` (env var or argument)
 * MUST win over `XDG_RUNTIME_DIR`. Linux desktops set the runtime dir
 * unconditionally, and the previous resolver placed the socket there
 * regardless — which made `dev:sandbox` / any isolated-state daemon
 * share a socket with the production daemon. Same socket = collisions
 * + cross-contamination.
 */

import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { defaultDaemonPidPath, defaultDaemonSocketPath, fitSocketPath, shortHomeTag } from "@/daemon/paths"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const PREV = {
  KOBE_HOME_DIR: process.env.KOBE_HOME_DIR,
  KOBE_DAEMON_SOCKET_PATH: process.env.KOBE_DAEMON_SOCKET_PATH,
  KOBE_DAEMON_PID_PATH: process.env.KOBE_DAEMON_PID_PATH,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
}

beforeEach(() => {
  Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  Reflect.deleteProperty(process.env, "KOBE_DAEMON_SOCKET_PATH")
  Reflect.deleteProperty(process.env, "KOBE_DAEMON_PID_PATH")
  Reflect.deleteProperty(process.env, "XDG_RUNTIME_DIR")
})

afterEach(() => {
  if (PREV.KOBE_HOME_DIR === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = PREV.KOBE_HOME_DIR
  if (PREV.KOBE_DAEMON_SOCKET_PATH === undefined) Reflect.deleteProperty(process.env, "KOBE_DAEMON_SOCKET_PATH")
  else process.env.KOBE_DAEMON_SOCKET_PATH = PREV.KOBE_DAEMON_SOCKET_PATH
  if (PREV.KOBE_DAEMON_PID_PATH === undefined) Reflect.deleteProperty(process.env, "KOBE_DAEMON_PID_PATH")
  else process.env.KOBE_DAEMON_PID_PATH = PREV.KOBE_DAEMON_PID_PATH
  if (PREV.XDG_RUNTIME_DIR === undefined) Reflect.deleteProperty(process.env, "XDG_RUNTIME_DIR")
  else process.env.XDG_RUNTIME_DIR = PREV.XDG_RUNTIME_DIR
})

describe("defaultDaemonSocketPath", () => {
  test("KOBE_DAEMON_SOCKET_PATH override wins over every derived path", () => {
    process.env.KOBE_HOME_DIR = "/tmp/from-env"
    process.env.XDG_RUNTIME_DIR = "/run/user/1000"
    process.env.KOBE_DAEMON_SOCKET_PATH = "/tmp/kobe-owned.sock"
    expect(defaultDaemonSocketPath()).toBe("/tmp/kobe-owned.sock")
  })

  test("caller-supplied homeDir argument wins over XDG_RUNTIME_DIR", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000"
    expect(defaultDaemonSocketPath("/tmp/sandbox-home")).toBe("/tmp/sandbox-home/.kobe/daemon.sock")
  })

  test("explicit KOBE_HOME_DIR env var wins over XDG_RUNTIME_DIR", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000"
    process.env.KOBE_HOME_DIR = "/tmp/from-env"
    expect(defaultDaemonSocketPath()).toBe("/tmp/from-env/.kobe/daemon.sock")
  })

  test("falls back to XDG_RUNTIME_DIR when no home override is set", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000"
    expect(defaultDaemonSocketPath()).toBe("/run/user/1000/kobe.sock")
  })

  test("falls back to $HOME/.kobe/daemon.sock when neither is set", () => {
    expect(defaultDaemonSocketPath()).toBe(join(homedir(), ".kobe", "daemon.sock"))
  })

  test("ignores empty XDG_RUNTIME_DIR (treats it as unset)", () => {
    process.env.XDG_RUNTIME_DIR = ""
    expect(defaultDaemonSocketPath()).toBe(join(homedir(), ".kobe", "daemon.sock"))
  })

  test("two isolated home dirs produce disjoint socket paths", () => {
    // The whole point of the fix: dev:sandbox and prod must not
    // collide. Even with XDG set, the two explicit homes diverge.
    process.env.XDG_RUNTIME_DIR = "/run/user/1000"
    const prod = defaultDaemonSocketPath("/Users/me")
    const sandbox = defaultDaemonSocketPath("/Users/me/.dev-sandbox/home")
    expect(prod).not.toBe(sandbox)
  })
})

describe("defaultDaemonPidPath", () => {
  test("KOBE_DAEMON_PID_PATH override wins over KOBE_HOME_DIR", () => {
    process.env.KOBE_HOME_DIR = "/tmp/from-env"
    process.env.KOBE_DAEMON_PID_PATH = "/tmp/kobe-owned.pid"
    expect(defaultDaemonPidPath()).toBe("/tmp/kobe-owned.pid")
  })

  test("uses KOBE_HOME_DIR when set (XDG never relevant for pidfile)", () => {
    process.env.KOBE_HOME_DIR = "/tmp/from-env"
    expect(defaultDaemonPidPath()).toBe("/tmp/from-env/.kobe/daemon.pid")
  })

  test("falls back to $HOME/.kobe/daemon.pid", () => {
    expect(defaultDaemonPidPath()).toBe(join(homedir(), ".kobe", "daemon.pid"))
  })
})

describe("fitSocketPath — sun_path length fallback", () => {
  // The kernel's struct sockaddr_un.sun_path is 104 bytes on macOS,
  // 108 on Linux. Worktree-based dev:sandbox paths can easily blow
  // past that; without the fallback `listen()` fails silently.

  test("returns the natural path when it's short enough", () => {
    const natural = "/tmp/short-home/.kobe/daemon.sock"
    expect(fitSocketPath(natural, "/tmp/short-home", "daemon")).toBe(natural)
  })

  test("falls back to $TMPDIR/kobe-<homeTag>-<role>.sock when natural path is too long", () => {
    const longHome = "/Users/me/i/kobe/.claude/worktrees/01KRAHRS48X42YK9TRJ2VE5X1F/packages/kobe/.dev-sandbox/home"
    const natural = `${longHome}/.kobe/daemon.sock`
    const fitted = fitSocketPath(natural, longHome, "daemon")
    expect(fitted).not.toBe(natural)
    expect(fitted.length).toBeLessThanOrEqual(100)
    expect(fitted.startsWith(tmpdir())).toBe(true)
    expect(fitted).toMatch(/kobe-[0-9a-f]{8}-daemon\.sock$/)
  })

  test("same homeDir + role → same short path (stable across calls)", () => {
    const longHome = "/very/long/home/path/that/blows/past/the/socket/limit/easy/easy"
    const a = fitSocketPath(`${longHome}/x.sock`, longHome, "daemon")
    const b = fitSocketPath(`${longHome}/x.sock`, longHome, "daemon")
    expect(a).toBe(b)
  })

  test("different homes → different short paths (no collision)", () => {
    const homeA = "/very/long/home/path/that/blows/past/the/socket/limit/easy/A"
    const homeB = "/very/long/home/path/that/blows/past/the/socket/limit/easy/B"
    const a = fitSocketPath(`${homeA}/x.sock`, homeA, "daemon")
    const b = fitSocketPath(`${homeB}/x.sock`, homeB, "daemon")
    expect(a).not.toBe(b)
  })

  test("pidTag is appended for ephemeral sockets (bridge)", () => {
    const longHome = "/Users/me/i/kobe/.claude/worktrees/01KRAHRS48X42YK9TRJ2VE5X1F/packages/kobe/.dev-sandbox/home"
    const fitted = fitSocketPath(`${longHome}/.kobe/run/bridge-12345.sock`, longHome, "bridge", 12345)
    expect(fitted).toMatch(/kobe-[0-9a-f]{8}-bridge-12345\.sock$/)
  })

  test("daemon socket falls back automatically through defaultDaemonSocketPath", () => {
    const longHome = "/Users/me/i/kobe/.claude/worktrees/01KRAHRS48X42YK9TRJ2VE5X1F/packages/kobe/.dev-sandbox/home"
    const result = defaultDaemonSocketPath(longHome)
    expect(result.startsWith(tmpdir())).toBe(true)
    expect(result.length).toBeLessThanOrEqual(100)
  })

  test("shortHomeTag is a stable 8-char hex tag", () => {
    const tag = shortHomeTag("/some/home")
    expect(tag).toMatch(/^[0-9a-f]{8}$/)
    // determinism
    expect(shortHomeTag("/some/home")).toBe(tag)
  })
})
