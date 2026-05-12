/**
 * Standalone-binary build entry.
 *
 * Produces two compiled binaries for the *current platform* via
 * `Bun.build({ compile: true })`:
 *
 *   ./release-bin/kobe
 *   ./release-bin/kobed
 *
 * Output lives outside `./dist/` on purpose: `dist/` is what `npm
 * publish` ships, and embedding 60+ MB executables into the npm
 * tarball would bloat installs that only need the JS bundle.
 *
 * Cross-compilation is intentionally not used. `@opentui/core` loads
 * `@opentui/core-${platform}-${arch}` via a runtime template-literal
 * import; the matching native subpackage ships with platform/cpu
 * restrictions in its package.json, so npm/bun won't install a foreign
 * one on the host. Each release matrix runner therefore builds for its
 * own platform — no `target:` override here.
 *
 * Unlike `build.ts`, `@opentui/core` is *not* external: `--compile`
 * needs to embed the bundled core (and thus the matching native
 * subpackage) into the executable's VFS. `node-pty` stays external as
 * before — it isn't used in production code (we drive PTYs via tmux),
 * only by the test driver.
 */

import { mkdirSync } from "node:fs"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const OUT_DIR = "./release-bin"
mkdirSync(OUT_DIR, { recursive: true })

const ENTRIES: Array<{ name: string; entry: string }> = [
  { name: "kobe", entry: "./src/cli/index.ts" },
  { name: "kobed", entry: "./src/bin/kobed.ts" },
]

for (const { name, entry } of ENTRIES) {
  const outfile = `${OUT_DIR}/${name}`
  const result = await Bun.build({
    entrypoints: [entry],
    conditions: ["browser"],
    plugins: [createSolidTransformPlugin()],
    external: ["node-pty"],
    compile: { outfile },
  })
  if (!result.success) {
    console.error(`compile ${name} failed:`)
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  console.log(`compiled ${outfile}`)
}
