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
 * Output: `dist/index.js` with `#!/usr/bin/env bun` shebang (preserved
 * from `src/cli/index.ts`) and 755 perms so `npm install -g` produces
 * a runnable `kobe` binary.
 */

import { chmod } from "node:fs/promises"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const OUT_FILE = "./dist/index.js"

const result = await Bun.build({
  entrypoints: ["./src/cli/index.ts"],
  outdir: "./dist",
  target: "bun",
  conditions: ["browser"],
  // Pass the plugin in directly. The "global" registration via
  // `ensureSolidTransformPlugin` is what `--preload` uses for the dev
  // runtime, but Bun.build only honours plugins passed in this list.
  plugins: [createSolidTransformPlugin()],
  // Keep node-pty / fs / etc. external — they're either Bun built-ins
  // or native modules that don't bundle.
  external: ["node-pty"],
})

if (!result.success) {
  console.error("build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await chmod(OUT_FILE, 0o755)
console.log(`built ${OUT_FILE}`)
