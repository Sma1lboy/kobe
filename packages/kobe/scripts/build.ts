/**
 * Production build entry.
 *
 * Driven from a script (rather than a bare `bun build` CLI call) so the web
 * dashboard build + dist copy can run alongside the CLI bundle. The React TUI
 * uses `@opentui/react`'s per-file `@jsxImportSource` pragmas, which Bun's
 * default transpiler honours — no build plugin required.
 *
 * Output: `dist/cli/kobe.js` and `dist/cli/rove.js` with executable perms,
 * plus their shared `index.js` implementation. After
 * the kobed → kobe bin merge (KOB-136), daemon lifecycle lives at
 * `kobe daemon ...`, so there is no separate `kobed` binary to build.
 *
 * The canonical SKILL.md (`.agents/skills/kobe/SKILL.md`, ~8KB) is COPIED
 * into the tarball. `npx skills add Sma1lboy/kobe` does a `git clone
 * --depth 1`, which for this repo means 198MB of working tree — unusable
 * on a slow connection for a file this size. Since the user already has
 * kobe installed, `kobe skill install` points the agent-skills CLI at the
 * bundled copy instead (a local path, no network). The CLI still owns
 * agent detection, target dirs, and symlinking — kobe never reimplements
 * that registry.
 *
 * The published artifact carries the browser dashboard alongside the TUI.
 * `kobe web` serves the built SPA from dist/web-ui through the daemon-owned
 * web transport.
 */

import { existsSync } from "node:fs"
import { chmod, cp, mkdir, rm } from "node:fs/promises"

const OUT_FILES = ["./dist/cli/kobe.js", "./dist/cli/rove.js"]
/** Canonical skill source (repo root) → its home in the tarball. */
const SKILL_SRC_DIR = "../../.agents/skills/kobe"
const SKILL_OUT_DIR = "./dist/skills/kobe"
const WEB_PACKAGE_DIR = "../kobe-web"
const WEB_DIST_DIR = `${WEB_PACKAGE_DIR}/dist`
const WEB_OUT_DIR = "./dist/web-ui"
const WEB_PTY_SIDE_CAR_FILES = [
  "origin-policy.mjs",
  "pty-scrollback.mjs",
  "pty-session-lifecycle.mjs",
  "pty-server.mjs",
]

async function buildWebUi(): Promise<void> {
  if (!existsSync(`${WEB_PACKAGE_DIR}/package.json`)) return
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: WEB_PACKAGE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) process.exit(code)
}

async function copyWebUi(): Promise<void> {
  if (!existsSync(`${WEB_DIST_DIR}/index.html`)) return
  // Empty dist/web-ui before copying. Vite hashes filenames per build
  // (index-<hash>.js/.css), so without this old generations pile up here
  // forever on a long-lived checkout and ship in the npm tarball. Mirror
  // vite's own emptyOutDir: wipe + recreate, then copy the fresh bundle.
  await rm(WEB_OUT_DIR, { recursive: true, force: true })
  await mkdir(WEB_OUT_DIR, { recursive: true })
  await cp(WEB_DIST_DIR, WEB_OUT_DIR, { recursive: true, force: true })
  // The PTY server runs unbundled under Node, so every sibling module it
  // imports must ship next to it (missing one = ERR_MODULE_NOT_FOUND at
  // `kobe web` startup in the packaged build).
  for (const file of WEB_PTY_SIDE_CAR_FILES) {
    await cp(`${WEB_PACKAGE_DIR}/${file}`, `${WEB_OUT_DIR}/${file}`, { force: true })
  }
}

/**
 * Copy the canonical skill into the tarball. Hard-fails when it's missing:
 * a silently skill-less build ships a `kobe skill install` that can only
 * report "not bundled", which is worse than a red build.
 */
async function copySkill(): Promise<void> {
  if (!existsSync(`${SKILL_SRC_DIR}/SKILL.md`)) {
    console.error(`build failed: canonical skill missing at ${SKILL_SRC_DIR}/SKILL.md`)
    process.exit(1)
  }
  await rm(SKILL_OUT_DIR, { recursive: true, force: true })
  await mkdir(SKILL_OUT_DIR, { recursive: true })
  await cp(SKILL_SRC_DIR, SKILL_OUT_DIR, { recursive: true, force: true })
}

await buildWebUi()

const result = await Bun.build({
  entrypoints: ["./src/cli/index.ts", "./src/cli/kobe.ts", "./src/cli/rove.ts"],
  outdir: "./dist",
  root: "./src",
  target: "bun",
  conditions: ["browser"],
  // Keep native/runtime-resolved packages external. @opentui/core loads
  // @opentui/core-${platform}-${arch} dynamically; bundling core moves
  // that dynamic import into dist/index.js, where Bun can no longer
  // resolve the optional platform package under isolated installs.
  external: ["node-pty", "@opentui/core"],
  minify: true,
})

if (!result.success) {
  console.error("build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// The Windows PTY host, as a NODE program. Bun rejects its `terminal` spawn
// option on Windows, and a Bun-hosted node-pty session cannot be written to,
// so that one process runs under node (see kobe-daemon/daemon/pty-driver.ts).
// Emitted unconditionally — the npm tarball is built once and installed on
// every OS, so this file must exist in it regardless of the build machine.
const ptyHostNode = await Bun.build({
  entrypoints: ["../kobe-daemon/src/daemon/pty-host-node-entry.ts"],
  outdir: "./dist/cli",
  target: "node",
  format: "esm",
  naming: "pty-host-node.mjs",
  // node-pty is a native module resolved from the installed package's own
  // node_modules; bundling its napi loader would break that lookup.
  external: ["node-pty"],
})

if (!ptyHostNode.success) {
  console.error("pty-host node build failed:")
  for (const log of ptyHostNode.logs) console.error(log)
  process.exit(1)
}

for (const file of OUT_FILES) await chmod(file, 0o755)
await copyWebUi()
await copySkill()

console.log(`built ${OUT_FILES.join(", ")}, ./dist/cli/pty-host-node.mjs, ${SKILL_OUT_DIR}`)
