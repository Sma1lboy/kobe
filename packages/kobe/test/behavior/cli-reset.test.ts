/**
 * `kobe reset` black-box lifecycle contract. The real built CLI starts and
 * stops a real standalone PTY host, but only inside the behavior harness's
 * disposable home; production sockets and processes are never in scope.
 */

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, type CliResult, DIST_CLI, makeBehaviorEnv } from "./harness.ts"

async function until(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timeout: ${label}`)
}

function runKobeAsync(args: readonly string[], env: BehaviorEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [DIST_CLI, ...args], { env: env.env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

describe("kobe reset (behavior)", () => {
  let env: BehaviorEnv

  beforeAll(async () => {
    env = await makeBehaviorEnv()
  })

  afterAll(async () => {
    await env.dispose()
  })

  it("stops the standalone pty host so the next launch uses current code", async () => {
    const socketPath = join(env.home, ".kobe", "pty.sock")
    const pidPath = join(env.home, ".kobe", "pty.pid")
    const host = spawn("bun", [DIST_CLI, "pty-host"], { env: env.env, stdio: "ignore" })

    try {
      await until(() => existsSync(socketPath) && existsSync(pidPath), "isolated pty host starts")
      expect(Number(readFileSync(pidPath, "utf8").trim())).toBe(host.pid)

      // Keep this runner async so Node can reap the host child while reset
      // polls its PID; a spawnSync parent would leave a transient zombie and
      // make the reset child escalate even though the host exited cleanly.
      const result = await runKobeAsync(["reset", "--yes"], env)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("pty host: stopped via graceful")
      expect(result.stdout).toContain("next launch starts a fresh host")

      await until(() => host.exitCode !== null, "reset stops isolated pty host")
      expect(existsSync(socketPath)).toBe(false)
      expect(existsSync(pidPath)).toBe(false)
    } finally {
      if (host.exitCode === null) host.kill("SIGKILL")
    }
  }, 15_000)
})
