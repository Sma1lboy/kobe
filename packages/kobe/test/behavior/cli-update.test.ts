/**
 * `kobe update` black-box behavior + the update.sh package-manager matrix.
 *
 * Pins issue #205's class: the update must run through the package manager
 * that OWNS the `kobe` on PATH, or the new version lands in another prefix
 * and PATH keeps resolving the stale install. The manager decision lives in
 * scripts/update.sh (fetched remotely by `kobe update`), so the matrix here
 * executes that actual script with a fully shimmed PATH — fake `kobe`, `npm`,
 * `bun` that log their argv — and asserts which manager got the install.
 */

import { spawnSync } from "node:child_process"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, makeBehaviorEnv, runKobe } from "./harness.ts"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const UPDATE_SH = join(REPO_ROOT, "scripts/update.sh")

describe("kobe update (behavior)", () => {
  let env: BehaviorEnv
  beforeAll(async () => {
    env = await makeBehaviorEnv()
  })
  afterAll(async () => {
    await env.dispose()
  })

  it("--dry-run prints the plan and runs nothing, exit 0", () => {
    const r = runKobe(["update", "--dry-run"], env)
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/kobe \d+\.\d+\.\d+ -> latest/)
    expect(r.stdout).toContain("running: curl")
  })

  it("unknown flag lands on the usage surface, exit 2", () => {
    const r = runKobe(["update", "--harf"], env)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("Usage: kobe update")
  })
})

/**
 * Run scripts/update.sh with PATH shims. `kobeBinDir` decides the manager
 * (a path containing `/.bun/` → bun, else npm). Both managers log to
 * `calls.log` instead of installing anything.
 */
async function runUpdateScript(base: string, kobeBinDir: string): Promise<{ code: number; out: string; log: string }> {
  const shims = join(base, "shims")
  await mkdir(shims, { recursive: true })
  await mkdir(kobeBinDir, { recursive: true })
  const logFile = join(base, "calls.log")

  // Post-install `kobe -v` must match `npm view` output or the script exits 1
  // (the shadowed-install guard) — keep both at 9.9.9 for the happy path.
  await writeFile(join(kobeBinDir, "kobe"), `#!/bin/sh\necho "kobe 9.9.9"\n`)
  await chmod(join(kobeBinDir, "kobe"), 0o755)
  for (const mgr of ["npm", "bun"]) {
    await writeFile(
      join(shims, mgr),
      `#!/bin/sh\necho "${mgr} $@" >> ${logFile}\nif [ "$1" = "view" ]; then echo "9.9.9"; fi\n`,
    )
    await chmod(join(shims, mgr), 0o755)
  }

  const r = spawnSync("sh", [UPDATE_SH], {
    env: { PATH: `${kobeBinDir}:${shims}:/usr/bin:/bin` },
    encoding: "utf8",
    timeout: 30_000,
  })
  const log = await readFile(logFile, "utf8").catch(() => "")
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, log }
}

describe("scripts/update.sh manager detection (issue #205)", () => {
  let env: BehaviorEnv
  beforeAll(async () => {
    env = await makeBehaviorEnv()
  })
  afterAll(async () => {
    await env.dispose()
  })

  it("a bun-owned kobe (path contains /.bun/) updates via bun", async () => {
    const base = join(env.home, "case-bun")
    const r = await runUpdateScript(base, join(base, ".bun", "bin"))
    expect(r.code).toBe(0)
    expect(r.out).toContain("via bun")
    expect(r.log).toContain("bun install -g @sma1lboy/kobe@latest")
    expect(r.log).not.toContain("npm install")
  })

  it("any other kobe location updates via npm", async () => {
    const base = join(env.home, "case-npm")
    const r = await runUpdateScript(base, join(base, "npm-global", "bin"))
    expect(r.code).toBe(0)
    expect(r.out).toContain("via npm")
    expect(r.log).toContain("npm install -g @sma1lboy/kobe@latest")
    expect(r.log).not.toContain("bun install")
  })

  it("a post-install PATH still resolving a stale version fails loudly", async () => {
    const base = join(env.home, "case-stale")
    const shims = join(base, "shims")
    const bin = join(base, "bin")
    await mkdir(shims, { recursive: true })
    await mkdir(bin, { recursive: true })
    // kobe stays at 1.0.0 while the registry says 9.9.9 → shadowed install.
    await writeFile(join(bin, "kobe"), `#!/bin/sh\necho "kobe 1.0.0"\n`)
    await chmod(join(bin, "kobe"), 0o755)
    for (const mgr of ["npm", "bun"]) {
      await writeFile(join(shims, mgr), `#!/bin/sh\nif [ "$1" = "view" ]; then echo "9.9.9"; fi\n`)
      await chmod(join(shims, mgr), 0o755)
    }
    const r = spawnSync("sh", [UPDATE_SH], {
      env: { PATH: `${bin}:${shims}:/usr/bin:/bin` },
      encoding: "utf8",
      timeout: 30_000,
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("shadowing")
  })
})
