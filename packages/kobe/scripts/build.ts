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
 * Sidecar assets: `share/skills/kobe/SKILL.md` is copied to
 * `dist/share/skills/kobe/SKILL.md` so `kobe skill install` (KOB-137)
 * can find it post-bundle. The `files` field in package.json includes
 * `dist`, so this is the only mirror needed for npm publish.
 */

import { chmod, cp, mkdir } from "node:fs/promises"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const OUT_FILES = ["./dist/cli/index.js"]

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
})

if (!result.success) {
  console.error("build failed:")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

for (const file of OUT_FILES) await chmod(file, 0o755)

// Mirror sidecar assets into dist/ so they ship in the npm tarball.
// `kobe skill install` resolves the bundled SKILL.md via `dist/share/`
// when running from an installed npm package.
await cp("./share", "./dist/share", { recursive: true })

// The interactive-claude PTY host (KOB-208) is a `.cjs` Node script the
// bundler can't inline — it runs as its own process. Mirror it into
// `dist/share/` so `HostClient` resolves it post-bundle.
await mkdir("./dist/share/interactive-claude", { recursive: true })
await cp("./src/engine/interactive-claude/pty-host.cjs", "./dist/share/interactive-claude/pty-host.cjs")

console.log(`built ${OUT_FILES.join(", ")} + dist/share/`)
