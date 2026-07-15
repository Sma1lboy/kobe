import path from "node:path"
import { defineConfig } from "vitest/config"

const includeBehavior = process.env.KOBE_INCLUDE_BEHAVIOR === "1"
const includeSocket = process.env.KOBE_INCLUDE_SOCKET === "1"
const includeDaemonCoverage = process.env.KOBE_COVERAGE_DAEMON === "1"
// test/render/** is the bun-test-only render track (see test/render/harness.tsx
// + docs/HARNESS.md "render track") — it uses bun:test APIs vitest can't
// resolve, and mounts real opentui Solid components vitest's node
// environment can't execute at all. Always excluded here regardless of the
// behavior/socket flags.
const exclude: string[] = ["test/render/**"]
if (!includeBehavior) exclude.push("test/behavior/**")
if (!includeSocket) {
  exclude.push("test/daemon/**", "test/orchestrator/bridge.test.ts")
}

export default defineConfig({
  // Mirror tsconfig.json's `paths` so runtime tests can import via
  // the `@/*`, `@engine/*`, `@types/*` etc. aliases the same way the
  // src tree does. Without this vitest fails to resolve `@/...`
  // imports at runtime (it consults vite's resolver, not tsc's).
  resolve: {
    alias: {
      "@/": `${path.resolve(__dirname, "src")}/`,
      "@tui/": `${path.resolve(__dirname, "src/tui")}/`,
      "@engine/": `${path.resolve(__dirname, "src/engine")}/`,
      "@orchestrator/": `${path.resolve(__dirname, "src/orchestrator")}/`,
      "@types/": `${path.resolve(__dirname, "src/types")}/`,
      "@test/": `${path.resolve(__dirname, "test")}/`,
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude,
    environment: "node",
    // `bun run coverage` / --coverage. v8 provider; json-summary feeds the
    // per-touched-file CI gate (scripts/coverage-gate.mjs), text is for humans.
    // No global % thresholds — the gate is per-file on files a PR touches.
    // SCOPE: .ts only. opentui Solid components (src/**/*.tsx) cannot execute
    // under vitest's node environment at all (0/6591 lines — the renderer
    // needs a real terminal); their behavior is covered black-box by
    // test/behavior/ (spawned dist subprocesses v8 can't attribute). Keeping
    // them in the denominator made the % measure the runtime, not the tests.
    coverage: {
      provider: "v8",
      // Daemon tests live under this package but execute source from the
      // sibling kobe-daemon workspace. The opt-in socket-coverage track must
      // explicitly allow and include that external root; ordinary kobe
      // coverage keeps its existing package-local scope.
      allowExternal: includeDaemonCoverage,
      include: includeDaemonCoverage ? [path.resolve(__dirname, "../kobe-daemon/src/**/*.ts")] : ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: includeDaemonCoverage ? "./coverage-daemon" : "./coverage",
    },
  },
})
