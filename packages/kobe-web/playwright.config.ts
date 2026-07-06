import { resolve } from "node:path"
import { defineConfig } from "@playwright/test"


const KOBE_DIR = resolve(import.meta.dirname, "../kobe")
const DEV_COMMAND = process.env.KOBE_PTY_DEV_COMMAND ?? "bun run dev:mock"

export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "bun run dev:vite",
      port: 5173,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node pty-server.mjs",
      port: 5175,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        KOBE_PTY_DEV_CWD: KOBE_DIR,
        KOBE_PTY_DEV_COMMAND: DEV_COMMAND,
      },
    },
  ],
})
