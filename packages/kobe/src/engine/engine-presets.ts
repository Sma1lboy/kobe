/**
 * Engine PRESETS and the command → protocol resolution behind them.
 *
 * The dispatch face (`rove api add` / `send --tab new`) takes a raw
 * `--command`, never a vendor: what an engine IS at launch is a command
 * line, and the protocol kobe speaks to it (which history reader, which
 * trust store, whether the first message may ride argv) is DERIVED from
 * that command rather than declared alongside it.
 *
 * Resolution is three-tiered — this module owns tier (a), the
 * deterministic one:
 *   a) `argv[0]` names a built-in binary or a registered preset ⇒ that
 *      preset's protocol. The main path, and the only one that answers
 *      before the process exists.
 *   b) post-launch sniffing (`./protocol-sniff.ts`) upgrades a session
 *      that tier (a) could not name.
 *   c) neither answers ⇒ {@link GENERIC_PROTOCOL}, which resolves to the
 *      registry's empty custom entry: no transcript reader, no hooks,
 *      silence-window liveness and settle-paste delivery.
 *
 * A CUSTOM engine is a NAMED PRESET: an id in `customEngineIds`, its
 * command in `engineCommand.<id>`, its display name in `engineName.<id>`,
 * and — new here — the protocol it speaks in `engineProtocol.<id>`,
 * declared once at registration so every later dispatch is deterministic
 * instead of re-sniffed. A preset registered before this key existed reads
 * as generic until its protocol is set.
 *
 * State-reading by construction, which is why it is NOT in `registry.ts`
 * (that module stays state-free so vitest and the daemon can import it).
 */

import { engineEntry } from "@/engine/registry"
import { getCustomEngineIds, getPersistedString } from "@/state/repos"
import { BUILTIN_VENDORS, type VendorId, isBuiltinVendor } from "@/types/vendor"
import { vendorFromArgv } from "./foreground.ts"
import {
  defaultEngineCommand,
  engineCommandKey,
  engineDisplayName,
  interactiveEngineCommand,
  parseEngineCommand,
  withEngineEffort,
  withEngineTerminalTitle,
} from "./interactive-command.ts"

/**
 * The protocol id for "kobe cannot name this engine". Deliberately not a
 * built-in vendor: {@link engineEntry} answers any unknown id with its
 * documented EMPTY entry, so the degraded path needs no branch of its own.
 */
export const GENERIC_PROTOCOL = "generic" as const

/**
 * Protocols a preset may declare. The built-ins, because a protocol IS a
 * built-in adapter — declaring one says "talk to my binary the way you talk
 * to claude". Derived from {@link BUILTIN_VENDORS} so a new built-in engine
 * becomes declarable without editing a second list.
 */
export const ENGINE_PROTOCOLS: readonly VendorId[] = BUILTIN_VENDORS

/** state.json key holding a custom preset's declared protocol. */
export function engineProtocolKey(id: string): string {
  return `engineProtocol.${id}`
}

/** A preset's declared protocol, or undefined (built-ins ARE their protocol). */
export function getEngineProtocol(id: string): VendorId | undefined {
  if (isBuiltinVendor(id)) return id
  const raw = getPersistedString(engineProtocolKey(id))?.trim()
  return raw && ENGINE_PROTOCOLS.includes(raw) ? raw : undefined
}

/** True when `id` names an engine kobe can launch by NAME alone. */
export function isPresetId(id: string): boolean {
  return isBuiltinVendor(id) || getCustomEngineIds().includes(id)
}

/** Every registered engine id, built-ins first. */
export function listPresetIds(): readonly string[] {
  return [...BUILTIN_VENDORS, ...getCustomEngineIds()]
}

/** One row of the `engine-list` verb — what the preset launches, verbatim. */
export interface EnginePreset {
  readonly id: string
  readonly name: string
  /** The exact command line this preset launches. What you see is what runs. */
  readonly command: string
  /** The adapter kobe speaks to it with; `generic` = no adapter knowledge. */
  readonly protocol: VendorId
  readonly builtin: boolean
}

export function describePreset(id: string): EnginePreset {
  const override = getPersistedString(engineCommandKey(id))?.trim()
  const command = override || defaultEngineCommand(id).join(" ")
  return {
    id,
    name: engineDisplayName(id),
    command,
    protocol: getEngineProtocol(id) ?? GENERIC_PROTOCOL,
    builtin: isBuiltinVendor(id),
  }
}

/** Every engine entry, built-in and custom, with its raw launch command. */
export function listEnginePresets(): readonly EnginePreset[] {
  return listPresetIds().map(describePreset)
}

/**
 * Tier (a): the protocol a raw launch command speaks, or
 * {@link GENERIC_PROTOCOL} when nothing in it is recognisable.
 *
 * Order matters. A bare preset id wins first so `--command my-aider` means
 * the registered preset (and its declared protocol), not a coincidental
 * binary of the same name. Otherwise the argv walk — the same one the
 * process-tree probe uses, so wrappers (`env FOO=1 claude`, `node …/codex.js`)
 * and post-launch renames (kimi → `kimi-co`) resolve identically here and at
 * runtime. Last, a preset whose OWN command starts with this binary: a user
 * who typed the preset's command by hand gets the protocol they declared.
 */
export function resolveCommandProtocol(command: string | undefined): VendorId {
  const trimmed = command?.trim()
  if (!trimmed) return GENERIC_PROTOCOL
  if (isPresetId(trimmed)) return getEngineProtocol(trimmed) ?? GENERIC_PROTOCOL
  const fromArgv = vendorFromArgv(trimmed)
  if (fromArgv) return fromArgv
  const argv0 = parseEngineCommand(trimmed)[0]
  if (argv0) {
    for (const id of getCustomEngineIds()) {
      const preset = getPersistedString(engineCommandKey(id))?.trim()
      if (preset && parseEngineCommand(preset)[0] === argv0) return getEngineProtocol(id) ?? GENERIC_PROTOCOL
    }
  }
  return GENERIC_PROTOCOL
}

/** What to launch for a task/tab: its pinned command, else its protocol's preset. */
export interface EngineLaunchSpec {
  /** Raw `--command` pinned on the task or tab; wins over `vendor`. */
  readonly command?: string
  /** Resolved protocol (or a preset id, on records that predate `command`). */
  readonly vendor?: VendorId
  readonly effort?: string
}

/**
 * Launch argv for a task or tab.
 *
 * Two things have to hold at once, and they pull apart for a custom preset:
 *
 *   - the BASE command comes from the preset id when there is one, so
 *     `--command claude` means "my claude" (the `engineCommand.claude`
 *     override configured in Settings), not a bare `claude` that ignores it;
 *   - the vendor-specific launch FLAGS (codex's effort + terminal-title
 *     config) come from the resolved PROTOCOL, not from the id. A preset
 *     `mycodex` declaring the codex protocol is a codex launch — keying the
 *     decoration off its id would find the empty custom registry entry and
 *     silently drop every flag, so a declared protocol would buy nothing at
 *     launch time.
 *
 * A built-in id resolves to itself, so this is the same argv it always was.
 */
export function engineLaunchArgv(spec: EngineLaunchSpec): readonly string[] {
  const command = spec.command?.trim()
  if (!command) return interactiveEngineCommand(spec.vendor, spec.effort)
  const vendor = (isPresetId(command) ? getEngineProtocol(command) : undefined) ?? resolveCommandProtocol(command)
  const base = isPresetId(command)
    ? presetBaseArgv(command)
    : (() => {
        const argv = parseEngineCommand(command)
        return argv.length > 0 ? argv : null
      })()
  if (!base) return interactiveEngineCommand(spec.vendor, spec.effort)
  return withEngineTerminalTitle(withEngineEffort(base, vendor, spec.effort), vendor)
}

/** A preset's UNDECORATED launch argv: its command override, else its default. */
function presetBaseArgv(id: string): readonly string[] | null {
  const override = getPersistedString(engineCommandKey(id))?.trim()
  if (override) {
    const argv = parseEngineCommand(override)
    if (argv.length > 0) return argv
  }
  return defaultEngineCommand(id)
}

/** The launch binary a delivery gate should match this spec's engine by. */
export function engineLaunchBin(spec: EngineLaunchSpec): string | undefined {
  return engineLaunchArgv(spec)[0]
}
