import { execSync } from "node:child_process"
import { resolve } from "node:path"

export default function globalTeardown(): void {
  try {
    execSync("bun run dev:sandbox:reset", {
      cwd: resolve(import.meta.dirname, "../../kobe"),
      stdio: "ignore",
    })
  } catch {
  }
}
