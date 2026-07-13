import { resolve } from "node:path"
import { defineConfig } from "@playwright/test"
import {
  VISUAL_DAEMON_PORT,
  VISUAL_ENV,
  VISUAL_HOME,
  VISUAL_PTY_COMMAND,
  VISUAL_PTY_PORT,
  VISUAL_WEB_PORT,
} from "./e2e/visual-fixture.ts"

const KOBE_DIR = resolve(import.meta.dirname, "../kobe")
const visual = process.env.KOBE_VISUAL === "1"
// Warm iteration mode: reuse a `visual:serve` server pair and keep the
// fixture alive after the run. Hermetic acceptance keeps strict ownership.
const keepWarm = visual && process.env.KOBE_VISUAL_KEEP === "1"
const webPort = visual ? VISUAL_WEB_PORT : 5173
const ptyPort = visual ? VISUAL_PTY_PORT : 5175
const devCommand = visual ? VISUAL_PTY_COMMAND : (process.env.KOBE_PTY_DEV_COMMAND ?? "bun run dev:mock")
const baseEnv = visual
  ? {
      ...VISUAL_ENV,
      KOBE_WEB_PORT: String(webPort),
      KOBE_PTY_PORT: String(ptyPort),
      KOBE_DAEMON_WEB_PORT: String(VISUAL_DAEMON_PORT),
    }
  : process.env

/**
 * Browser → xterm → PTY → OpenTUI. `KOBE_VISUAL=1` owns the one visual
 * ground-truth path: an isolated real dev:sandbox, fixed viewport, fresh
 * servers, and app-owned terminal synchronization seams.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: visual ? "./e2e/visual-fixture.ts" : undefined,
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://localhost:${webPort}`,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `bunx vite dev --port ${webPort} --strictPort`,
      port: webPort,
      reuseExistingServer: visual ? keepWarm : !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: baseEnv,
    },
    {
      // node-pty does not run under Bun; Playwright owns this Node sidecar.
      command: "node pty-server.mjs",
      port: ptyPort,
      reuseExistingServer: visual ? keepWarm : !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...baseEnv,
        KOBE_PTY_PORT: String(ptyPort),
        KOBE_PTY_DEV_CWD: KOBE_DIR,
        KOBE_PTY_DEV_COMMAND: devCommand,
        ...(visual ? { KOBE_SANDBOX_HOME_DIR: VISUAL_HOME } : {}),
      },
    },
  ],
})
