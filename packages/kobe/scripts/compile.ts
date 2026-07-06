/**
 * Standalone-binary build entry.
 *
 * Produces the compiled `kobe` binary for the *current platform* via
 * `Bun.build({ compile: true })`:
 *
 *   ./release-bin/kobe
 *
 * Output lives outside `./dist/` on purpose: `dist/` is what `npm
 * publish` ships, and embedding a 60+ MB executable into the npm
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
 * subpackage) into the executable's VFS. `node-pty` stays external; the web
 * dashboard ships in the npm `dist/web-ui` artifact, not inside the compiled
 * single-file binary.
 *
 * After the kobed → kobe bin merge (KOB-136), the single `kobe` binary
 * also hosts the daemon (`kobe daemon start|stop|status|restart`), so
 * there is no separate `kobed` binary to compile.
 */

import { mkdirSync } from "node:fs"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const OUT_DIR = "./release-bin"
mkdirSync(OUT_DIR, { recursive: true })

const outfile = `${OUT_DIR}/kobe`
const result = await Bun.build({
  entrypoints: ["./src/cli/index.ts"],
  conditions: ["browser"],
  plugins: [createSolidTransformPlugin()],
  external: ["node-pty"],
  minify: true,
  compile: { outfile },
})
if (!result.success) {
  console.error("compile failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log(`compiled ${outfile}`)
