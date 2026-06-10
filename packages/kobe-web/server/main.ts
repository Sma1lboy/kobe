/**
 * Dev entry for the bridge — run by dev.ts under `bun --watch`, so editing
 * any bridge file restarts just this process: the daemon, Vite, and the PTY
 * server are untouched. No static dir here; Vite serves the SPA in dev.
 */

import { createBridgeServer } from "./bridge.ts"

const port = Number.parseInt(process.env.KOBE_BRIDGE_PORT ?? "5174", 10)
const bridge = await createBridgeServer({ port })
console.log(`kobe-web bridge listening on http://localhost:${bridge.port} (routes only)`)

const shutdown = (): void => {
  bridge.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
