/**
 * kobe's JSX loader rule — ONE place (owner ask 2026-07-07: "统一入口规则").
 *
 * The repo hosts two JSX dialects during the Solid→React migration:
 * everything under `src/tui-react/` is React (`@jsxImportSource
 * @opentui/react` per-file pragmas), everything else Solid. The upstream
 * `@opentui/solid` transform plugin intercepts EVERY non-node_modules
 * `.tsx` and compiles it as Solid unconditionally — pragmas ignored —
 * which silently corrupted the React components into non-components (the
 * "KOBE_TUI=1 exits 1 with no output" boot crash once React became the
 * default implementation).
 *
 * Fix: register {@link reactPassthroughPlugin} BEFORE the Solid plugin.
 * Its onLoad claims `src/tui-react/**` first and hands the source back
 * with the plain `tsx`/`ts` loader — Bun's own transpiler then honours
 * the per-file React pragma. Everything else falls through to the Solid
 * transform exactly as before. Consumed by `jsx-preload.ts` (dev runtime,
 * bunfig) and `build.ts`/`compile.ts` (Bun.build plugin lists).
 */

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { BunPlugin } from "bun"

export const reactPassthroughPlugin: BunPlugin = {
  name: "kobe-react-jsx-passthrough",
  setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\]tui-react[/\\][^?#]*\.tsx?(?:[?#].*)?$/ }, async (args) => {
      const path = args.path.replace(/[?#].*$/, "")
      const contents = await Bun.file(path).text()
      return { contents, loader: path.endsWith(".tsx") ? "tsx" : "ts" }
    })
  },
}

/** Ordered plugin list for Bun.build: React passthrough must come first. */
export function kobeJsxPlugins(): BunPlugin[] {
  return [reactPassthroughPlugin, createSolidTransformPlugin()]
}
