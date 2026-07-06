import path from "node:path"
import { defineConfig } from "vitest/config"

const includeBehavior = process.env.KOBE_INCLUDE_BEHAVIOR === "1"
const includeSocket = process.env.KOBE_INCLUDE_SOCKET === "1"
const exclude: string[] = ["test/render/**"]
if (!includeBehavior) exclude.push("test/behavior/**")
if (!includeSocket) {
  exclude.push("test/daemon/**", "test/orchestrator/bridge.test.ts")
}

export default defineConfig({
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
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
})
