/**
 * `bun run visual:serve` — warm server pair for fast OpenTUI visual
 * iteration. Ensures the isolated fixture (skipping rebuild when warm),
 * then keeps Vite + the PTY sidecar up on the visual ports so each
 * `visual:dev` / `visual:shot` run only pays TUI startup. Ctrl-C stops it;
 * the hermetic `bun run visual` requires this to be stopped first.
 */

import { resolve } from "node:path"
import setupVisualFixture, {
  KOBE_DIR,
  VISUAL_DAEMON_PORT,
  VISUAL_ENV,
  VISUAL_HOME,
  VISUAL_PTY_COMMAND,
  VISUAL_PTY_PORT,
  VISUAL_WEB_PORT,
} from "./visual-fixture.ts"

await setupVisualFixture()

const child = Bun.spawn(["bun", "run", "dev.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  stdio: ["inherit", "inherit", "inherit"],
  env: {
    ...VISUAL_ENV,
    KOBE_HOME_DIR: VISUAL_HOME,
    KOBE_WEB_PORT: String(VISUAL_WEB_PORT),
    KOBE_DAEMON_WEB_PORT: String(VISUAL_DAEMON_PORT),
    KOBE_PTY_PORT: String(VISUAL_PTY_PORT),
    KOBE_PTY_DEV_CWD: KOBE_DIR,
    KOBE_PTY_DEV_COMMAND: VISUAL_PTY_COMMAND,
  },
})

console.error(`[visual:serve] warm on :${VISUAL_WEB_PORT} — run visual:dev / visual:shot; ctrl-c to stop`)
process.on("SIGINT", () => child.kill())
process.on("SIGTERM", () => child.kill())
process.exit(await child.exited)
