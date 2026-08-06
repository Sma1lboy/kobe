import path from "node:path"
import { defineConfig } from "vitest/config"

const includeBehavior = process.env.KOBE_INCLUDE_BEHAVIOR === "1"
const includeSocket = process.env.KOBE_INCLUDE_SOCKET === "1"
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
  },
})
