/**
 * Public surface of the kobe-web bridge server, consumed two ways:
 *   - `kobe web` (packages/kobe/src/cli/web-cmd.ts) imports it via the
 *     package export `kobe-web/server` only when the web command runs.
 *   - dev.ts runs ./main.ts directly (bun --watch) for the source dev loop.
 */

export {
  type BridgeServer,
  type BridgeServerOptions,
  createBridgeServer,
  takeoverPort,
  WEB_HEALTH_MARKER,
  WEB_HEALTH_PATH,
} from "./bridge.ts"
