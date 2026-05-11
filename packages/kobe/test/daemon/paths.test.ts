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

import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "@/daemon/paths"

const PREV = {
  KOBE_HOME_DIR: process.env.KOBE_HOME_DIR,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
}

beforeEach(() => {
  delete process.env.KOBE_HOME_DIR
  delete process.env.XDG_RUNTIME_DIR
})

afterEach(() => {
  if (PREV.KOBE_HOME_DIR === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = PREV.KOBE_HOME_DIR
  if (PREV.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = PREV.XDG_RUNTIME_DIR
})

describe("defaultDaemonSocketPath", () => {
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
  test("uses KOBE_HOME_DIR when set (XDG never relevant for pidfile)", () => {
    process.env.KOBE_HOME_DIR = "/tmp/from-env"
    expect(defaultDaemonPidPath()).toBe("/tmp/from-env/.kobe/daemon.pid")
  })

  test("falls back to $HOME/.kobe/daemon.pid", () => {
    expect(defaultDaemonPidPath()).toBe(join(homedir(), ".kobe", "daemon.pid"))
  })
})
