import { resolve } from "node:path"
import { defineConfig } from "@playwright/test"

/**
 * UI-layer e2e: Playwright opens the SPA, an xterm on `/pty-harness` runs a real
 * kobe TUI (dev:mock by default; dev:sandbox for the full tmux flow), and the
 * test drives it with keystrokes + asserts on the rendered `.xterm-rows` DOM.
 *
 * webServer boots ONLY Vite (5173) + the PTY sidecar (5175) — no daemon needed,
 * because the sidecar's KOBE_PTY_DEV_COMMAND override skips task/daemon spec
 * resolution. The browser dials the sidecar on port+2 (5175) directly, so both
 * ports are fixed. Override the TUI with KOBE_PTY_DEV_COMMAND=... to target
 * dev:sandbox.
 */

// packages/kobe (holds the dev:mock / dev:sandbox scripts) is a sibling of kobe-web.
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
      // node-pty doesn't run under bun — the sidecar is a node process.
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
