import { createDaemonHandlerRegistry, webExposedRpcNames } from "./handlers.ts"
import type { DaemonRequestName } from "./protocol.ts"

/**
 * The daemon RPCs the browser UI may invoke through POST /api/rpc.
 *
 * Thin shim over the handler registry: web exposure is declared per-entry
 * (`web: true` in handlers*.ts) so an RPC's browser reachability lives where
 * the handler is defined — this file no longer hand-maintains a list that
 * can drift from the registry. Kept as a re-export for existing importers
 * (kobe-web's allowlist contract test).
 */
export const WEB_RPC_ALLOWSET: ReadonlySet<string> = webExposedRpcNames(createDaemonHandlerRegistry())

export const WEB_RPC_ALLOWLIST: readonly DaemonRequestName[] = [...WEB_RPC_ALLOWSET] as DaemonRequestName[]
