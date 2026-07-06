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
