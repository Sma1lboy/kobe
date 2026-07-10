/**
 * Bridge a Solid `Accessor` into React state (issue #16 React workspace
 * host). `RemoteOrchestrator`'s live task/engine-state signals are Solid
 * signals — solid-js reactivity is inert outside a reactive-solid runtime —
 * and most of them have no framework-free `ExternalStore` twin yet (only
 * `uiPrefs`/`keybindingsRev`/`transcriptActivity` do, consumed elsewhere via
 * `useSyncExternalStore`). Rather than grow `RemoteOrchestrator`
 * with four more dual-write stores, this
 * hook subscribes directly via a headless `createRoot`/`createEffect` — the
 * exact technique `RemoteOrchestrator.subscribeTasks` already uses
 * internally to hand Solid signal updates to non-Solid callers.
 *
 * The accessor itself must be REFERENTIALLY STABLE for the orchestrator's
 * lifetime (every `RemoteOrchestrator.*Signal()` getter returns the same
 * closure each call) — that's the effect's only dependency.
 */

import { useEffect, useState } from "react"
import type { Accessor } from "solid-js"
import { createEffect, createRoot } from "solid-js"

export function useAccessor<T>(acc: Accessor<T>): T {
  const [value, setValue] = useState<T>(() => acc())
  useEffect(() => {
    return createRoot((dispose) => {
      createEffect(() => setValue(acc()))
      return dispose
    })
  }, [acc])
  return value
}
