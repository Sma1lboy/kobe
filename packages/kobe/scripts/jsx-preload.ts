/**
 * Dev-runtime preload — replaces the bare `@opentui/solid/preload`.
 * Registration ORDER is the contract: the React passthrough must claim
 * `src/tui-react/**` before the Solid transform's catch-all filter sees
 * it. See `jsx-plugin.ts` for the full rule.
 */

import { plugin } from "bun"
import { kobeJsxPlugins } from "./jsx-plugin"

for (const p of kobeJsxPlugins()) plugin(p)
