import { getIdentity } from "@/engine/registry"
import type { SessionMeta } from "@/types/engine"

export function engineLabel(session: SessionMeta): string {
  return session.vendor ? getIdentity(session.vendor).shortName : "engine"
}
