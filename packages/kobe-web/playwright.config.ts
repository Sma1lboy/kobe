import { resolve } from "node:path"
import { defineConfig } from "@playwright/test"
import {
  VISUAL_DAEMON_PORT,
  VISUAL_ENV,
  VISUAL_HOME,
  VISUAL_PTY_PORT,
  VISUAL_WEB_PORT,
} from "./e2e/visual-fixture.ts"

const KOBE_DIR = resolve(import.meta.dirname, "../kobe")
const visual = process.env.KOBE_VISUAL === "1"
const webPort = visual ? VISUAL_WEB_PORT : 5173
const ptyPort = visual ? VISUAL_PTY_PORT : 5175
// The isolated home is inlined into the command itself: the PTY child runs
// under `/bin/sh -lc`, and a login shell or env-passing gap must NEVER let it
// fall back to the shared `.dev-sandbox/home` (the owner's live environment).
const devCommand = visual
  ? `HOME=${VISUAL_HOME} KOBE_SANDBOX_HOME_DIR=${VISUAL_HOME} KOBE_HOME_DIR=${VISUAL_HOME} XDG_CONFIG_HOME=${VISUAL_HOME}/.config KOBE_DAEMON_WEB_PORT=${VISUAL_DAEMON_PORT} bun run dev:sandbox`
  : (process.env.KOBE_PTY_DEV_COMMAND ?? "bun run dev:mock")
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
      reuseExistingServer: visual ? false : !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: baseEnv,
    },
    {
      // node-pty does not run under Bun; Playwright owns this Node sidecar.
      command: "node pty-server.mjs",
      port: ptyPort,
      reuseExistingServer: visual ? false : !process.env.CI,
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
