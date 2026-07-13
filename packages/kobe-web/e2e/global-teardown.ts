import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { cleanupVisualFixture, VISUAL_HOME } from "./visual-fixture.ts"

/** Stop only the sandbox processes owned by this E2E run. */
export default async function globalTeardown(): Promise<void> {
  if (process.env.KOBE_VISUAL === "1") {
    try {
      await cleanupVisualFixture()
    } catch (error) {
      throw new Error(
        `visual cleanup failed for ${VISUAL_HOME}; retry with KOBE_SANDBOX_HOME_DIR=${VISUAL_HOME} bun run dev:sandbox:reset`,
        { cause: error },
      )
    }
    return
  }

  if (!process.env.KOBE_PTY_DEV_COMMAND?.includes("sandbox")) return
  execFileSync("bun", ["run", "dev:sandbox:reset"], {
    cwd: resolve(import.meta.dirname, "../../kobe"),
    stdio: "inherit",
  })
}
