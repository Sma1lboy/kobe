/**
 * Regression guard for #307: the shipped bundles must NOT contain React's
 * development build.
 *
 * Bun defaults `process.env.NODE_ENV` to "development" during `Bun.build`, so
 * without an explicit `define` the bundler resolves react/react-reconciler to
 * their development entries and inlines them. Those builds keep per-update
 * debug bookkeeping alive (fiber `_debugTask`/`_debugInfo`, update-timer
 * state), which in a long-lived TUI grows without bound — the process climbed
 * multiple GB over a session.
 *
 * Asserting on the build SCRIPTS rather than on `dist/` on purpose: `dist/` is
 * gitignored and absent on a fresh clone, so a bundle assertion would be a
 * silently-skipped test. The `define` is the invariant that produces the
 * bundle; guard that.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const SCRIPTS = ["build.ts", "compile.ts"]

describe("production React build", () => {
  for (const script of SCRIPTS) {
    test(`scripts/${script} pins NODE_ENV=production`, () => {
      const source = readFileSync(fileURLToPath(new URL(`../../scripts/${script}`, import.meta.url)), "utf8")
      expect(source).toContain('"process.env.NODE_ENV": JSON.stringify("production")')
    })
  }
})
