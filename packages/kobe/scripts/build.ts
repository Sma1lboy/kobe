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
  await rm(WEB_OUT_DIR, { recursive: true, force: true })
  await mkdir(WEB_OUT_DIR, { recursive: true })
  await cp(WEB_DIST_DIR, WEB_OUT_DIR, { recursive: true, force: true })
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
  plugins: [createSolidTransformPlugin()],
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
