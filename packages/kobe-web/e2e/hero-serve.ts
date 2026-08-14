/**
 * `bun e2e/hero-serve.ts` — the warm capture stack for README/docs assets:
 * Vite + the PTY sidecar on the hero ports, wired to the isolated hero home.
 * Keep it running, then shoot with `hero-shot.ts` / `hero-record.ts`.
 *
 * Deliberately does NOT rebuild its fixture on start (unlike `visual:serve`):
 * the hero home holds real engine transcripts that cost quota, and a capture
 * session re-frames the same sessions many times.
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  HERO_DAEMON_PORT,
  HERO_HOME,
  HERO_PTY_PORT,
  HERO_WEB_PORT,
  KOBE_DIR,
  heroEnv,
  heroPtyCommand,
} from "./hero-env.ts"

if (!existsSync(HERO_HOME)) throw new Error(`no hero fixture at ${HERO_HOME} — run \`bun e2e/hero-fixture.ts --fresh\``)

const child = Bun.spawn(["bun", "run", "dev.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  stdio: ["inherit", "inherit", "inherit"],
  env: {
    ...heroEnv(),
    KOBE_WEB_PORT: String(HERO_WEB_PORT),
    ROVE_WEB_PORT: String(HERO_WEB_PORT),
    KOBE_DAEMON_WEB_PORT: String(HERO_DAEMON_PORT),
    KOBE_PTY_PORT: String(HERO_PTY_PORT),
    ROVE_PTY_PORT: String(HERO_PTY_PORT),
    KOBE_PTY_DEV_CWD: KOBE_DIR,
    KOBE_PTY_DEV_COMMAND: heroPtyCommand(),
  },
})

console.error(`[hero:serve] warm on :${HERO_WEB_PORT} — hero-shot / hero-record; ctrl-c to stop`)
process.on("SIGINT", () => child.kill())
process.on("SIGTERM", () => child.kill())
process.exit(await child.exited)
