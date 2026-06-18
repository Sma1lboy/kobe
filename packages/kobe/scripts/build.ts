/**
 * Production build entry.
 *
 * `bun build` over the CLI alone can't resolve `@opentui/solid`'s JSX
 * runtime — the package's `./jsx-runtime` export points at a `.d.ts`
 * stub on disk, with the real Babel-driven transform installed at
 * runtime by `@opentui/solid/preload`. CLI `bun build` doesn't accept
 * plugins via flags, so we drive the build from a script that
 * registers the same Solid transform plugin first.
 *
 * Output: `dist/cli/index.js` with `#!/usr/bin/env bun` shebang and 755
 * perms so `npm install -g` produces a runnable `kobe` binary. After
 * the kobed → kobe bin merge (KOB-136), daemon lifecycle lives at
 * `kobe daemon ...`, so there is no separate `kobed` binary to build.
 *
 * Skill distribution stays OUT of the npm tarball: the canonical SKILL.md
 * lives at `.agents/skills/kobe/SKILL.md` and ships via the Vercel Labs
 * agent-skills CLI (`npx skills add Sma1lboy/kobe`). `kobe skill install`
 * is just a convenience WRAPPER that runs that npx flow for the user — kobe
 * doesn't bundle or copy the file, so there's nothing to emit here.
 */

import { existsSync } from "node:fs"
import { chmod, cp, mkdir, rm } from "node:fs/promises"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const OUT_FILES = ["./dist/cli/index.js"]
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

await buildWebUi()

const result = await Bun.build({
  entrypoints: ["./src/cli/index.ts"],
  outdir: "./dist",
  root: "./src",
  target: "bun",
  conditions: ["browser"],
  // Pass the plugin in directly. The "global" registration via
  // `ensureSolidTransformPlugin` is what `--preload` uses for the dev
  // runtime, but Bun.build only honours plugins passed in this list.
  plugins: [createSolidTransformPlugin()],
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

for (const file of OUT_FILES) await chmod(file, 0o755)
await copyWebUi()

console.log(`built ${OUT_FILES.join(", ")}`)
