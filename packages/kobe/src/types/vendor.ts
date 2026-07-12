/**
 * Engine vendor identifier (v0.6).
 *
 * v0.5 supported `"claude" | "codex" | "gemini"` so the engine
 * registry could route per-task. v0.6 drops gemini entirely (no
 * interactive TUI equivalent worth wrapping) and keeps the engines
 * whose interactive CLIs run in Hosted PTYs and whose on-disk history is
 * normalized by engine adapters: `"claude"`, `"codex"`, and `"copilot"`.
 *
 * Per-task vendor is still recorded on Task so the monitor knows
 * which history-reader to call.
 */
/**
 * Engine vendor id. The three built-ins (claude/codex/copilot) are
 * literals — they back the exhaustive maps + history-reader dispatch — but
 * the type is OPEN (`string & {}`) because users can register their own
 * engines (a slug id + launch command, see `state/repos.ts`
 * customEngineIds). A custom id is just a string that isn't one of the
 * three; it flows through Task metadata and selectors and resolves its
 * launch command from `engineCommand.<id>`.
 */
export type VendorId = "claude" | "codex" | "copilot" | (string & {})

/** The three first-party engines that ship with kobe (cycle order). */
export const BUILTIN_VENDORS = ["claude", "codex", "copilot"] as const
export type BuiltinVendorId = (typeof BUILTIN_VENDORS)[number]

/**
 * Built-in vendors, in cycle order. NB: this is the BUILT-IN set only;
 * surfaces that should also offer user-added engines (the new-task selector,
 * Settings → Engines) compose this with the customEngineIds registry rather
 * than reading this array directly.
 */
export const ALL_VENDORS: readonly VendorId[] = [...BUILTIN_VENDORS]

/** True when `id` is one of the three first-party engines (not a custom one). */
export function isBuiltinVendor(id: string | undefined): id is BuiltinVendorId {
  return id === "claude" || id === "codex" || id === "copilot"
}

/** Next vendor in {@link ALL_VENDORS} order, wrapping around. */
export function nextVendor(current: VendorId): VendorId {
  const i = ALL_VENDORS.indexOf(current)
  return ALL_VENDORS[(i + 1) % ALL_VENDORS.length] ?? ALL_VENDORS[0]
}

/**
 * Next vendor within an arbitrary subset (e.g. the detected-only list the
 * new-task dialog renders), wrapping around. `current` need not be in the
 * list — cycling starts from the first entry. Empty list returns `current`
 * unchanged so a caller with nothing detected never crashes.
 */
export function nextVendorWithin(list: readonly VendorId[], current: VendorId): VendorId {
  if (list.length === 0) return current
  const i = list.indexOf(current)
  return list[(i + 1) % list.length] ?? list[0] ?? current
}

/**
 * Previous vendor within an arbitrary subset, wrapping around — the
 * reverse of {@link nextVendorWithin}, powering ←/→ on the new-task
 * engine selector. A `current` not in the list starts from the last
 * entry; an empty list returns `current` unchanged.
 */
export function prevVendorWithin(list: readonly VendorId[], current: VendorId): VendorId {
  if (list.length === 0) return current
  const i = list.indexOf(current)
  if (i < 0) return list[list.length - 1] ?? current
  return list[(i - 1 + list.length) % list.length] ?? current
}

/**
 * Coerce an untrusted string (a CLI flag, a persisted record) to a
 * {@link VendorId}. Engines are now OPEN (users register their own), so a
 * non-empty value passes through as-is — a built-in OR a custom id; the
 * launch path resolves it from `engineCommand.<id>` and a truly bogus id
 * just fails to launch its (missing) binary. Only an empty/absent value
 * falls back to `"claude"`, the default for a task with no recorded vendor.
 */
export function coerceVendorId(value: string | undefined): VendorId {
  const v = value?.trim()
  return v && v.length > 0 ? v : "claude"
}

/**
 * Validate an untrusted PERSISTED vendor id (e.g. `lastSelectedVendor` read
 * from state.json) against the set of vendors kobe can actually launch: the
 * three built-ins PLUS the user's registered custom engines. Unlike
 * {@link coerceVendorId} (which only rejects empty), this rejects a corrupt or
 * typo'd value — one that is neither a built-in nor a registered custom id —
 * and falls back to `"claude"` ({@link DEFAULT_TASK_VENDOR} in `types/task.ts`)
 * rather than letting a bogus id flow into engine selection as the chosen
 * default and silently fail to launch a missing binary.
 *
 * Pass the user's `customEngineIds` registry (see
 * `state/repos.ts#getCustomEngineIds`) so a real custom engine id passes
 * through; omit it (defaults to `[]`) when only built-ins should be accepted.
 */
export function resolvePersistedVendor(value: string | undefined, customEngineIds: readonly string[] = []): VendorId {
  const v = value?.trim()
  if (!v) return "claude"
  if (isBuiltinVendor(v)) return v
  if (customEngineIds.includes(v)) return v
  return "claude"
}
