import { defineConfig } from "vitest/config"

export default defineConfig({
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
