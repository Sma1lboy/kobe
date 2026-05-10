import path from "node:path"
import { defineConfig } from "vitest/config"

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
    environment: "node",
    // Run *.test-d.ts files as type-level tests via tsc.
    // Stream 0.3's type contracts (src/types/**) are validated this way;
    // any drift between an interface and its consumers is caught here.
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.json",
    },
  },
})
