/**
 * Pure builder for kobe's default tmux root key-table bindings.
 *
 * The bootstrap calls {@link buildBindKeyArgs} once and feeds each argv
 * to `tmux ...` with the same `spawnSync` style as the layout / status
 * line steps. Keeping this module spawn-free means the chord set is
 * unit-testable without a tmux installed.
 *
 * Chord set (all on the root table — no prefix required):
 *
 *   M-1 … M-9   →  kobe rpc switch-tab <N>     (daemon round-trip)
 *   M-t         →  kobe rpc new-tab            (daemon round-trip)
 *   M-w         →  kobe rpc close-tab          (daemon round-trip)
 *   M-n         →  kobe rpc next-task          (daemon round-trip)
 *   M-p         →  kobe rpc prev-task          (daemon round-trip)
 *   M-h/j/k/l   →  tmux select-pane -L/-D/-U/-R (in-tmux, no daemon)
 *
 * Why root table + no-prefix: kobe owns the tmux session. The default
 * `C-b` prefix is preserved for the user's other tmux habits; kobe's
 * own chords use Alt-* so they're orthogonal. The pane-navigation
 * chords stay inside tmux to avoid a round-trip just to move the focus
 * rectangle — everything else needs the daemon to mutate state, so it
 * goes through `kobe rpc ... --no-wait`.
 */

export type TmuxBindArgv = readonly string[]

export interface KeybindingDef {
  /** Display name — used by docs / future overlays, not by tmux. */
  readonly label: string
  /** Key sequence as understood by `tmux bind-key`. */
  readonly key: string
  /**
   * Action descriptor. `rpc` builds a `run-shell "<kobeBin> rpc …"`
   * binding (daemon round-trip, fire-and-forget). `select-pane`
   * builds a direct tmux pane-navigation binding (no shell, no
   * daemon).
   */
  readonly action:
    | { readonly kind: "rpc"; readonly verb: string; readonly args: readonly string[] }
    | { readonly kind: "select-pane"; readonly direction: "L" | "D" | "U" | "R" }
}

export const DEFAULT_KEYBINDINGS: readonly KeybindingDef[] = [
  // M-1 … M-9 → switch-tab 1 … 9
  ...Array.from({ length: 9 }, (_, i) => {
    const n = i + 1
    return {
      label: `switch-tab-${n}`,
      key: `M-${n}`,
      action: { kind: "rpc" as const, verb: "switch-tab", args: [String(n)] },
    }
  }),
  { label: "new-tab", key: "M-t", action: { kind: "rpc", verb: "new-tab", args: [] } },
  { label: "close-tab", key: "M-w", action: { kind: "rpc", verb: "close-tab", args: [] } },
  // M-N (Shift+Alt+n) creates a new task. We pick Shift+Alt rather than
  // bare M-n so it doesn't collide with `next-task` (M-n) below.
  { label: "new-task", key: "M-N", action: { kind: "rpc", verb: "new-task", args: [] } },
  { label: "next-task", key: "M-n", action: { kind: "rpc", verb: "next-task", args: [] } },
  { label: "prev-task", key: "M-p", action: { kind: "rpc", verb: "prev-task", args: [] } },
  { label: "pane-left", key: "M-h", action: { kind: "select-pane", direction: "L" } },
  { label: "pane-down", key: "M-j", action: { kind: "select-pane", direction: "D" } },
  { label: "pane-up", key: "M-k", action: { kind: "select-pane", direction: "U" } },
  { label: "pane-right", key: "M-l", action: { kind: "select-pane", direction: "R" } },
]

export interface BuildBindKeyOptions {
  /**
   * tmux session/target. Unused for now (root-table bindings are
   * server-wide and apply across sessions) but kept in the contract so
   * a future per-session table can opt in without changing callers.
   */
  readonly session?: string
  /** Absolute path or argv prefix used to invoke `kobe rpc …`.
   *  Defaults to the plain `"kobe"` command (assumes it's on PATH).
   *  Dev runs override with `KOBE_BIN="bun /abs/path/src/cli/index.ts"`. */
  readonly kobeBin?: string
}

/**
 * Build the argv vectors for each binding. One argv per binding —
 * caller does `spawnSync("tmux", argv)`.
 *
 * Each argv starts with `["bind-key", "-n", "-T", "root", <key>, ...]`.
 * `-n` keeps the binding prefix-less; `-T root` is explicit even
 * though it's the default, because future per-session tables will
 * change this argument and we want one obvious place to edit.
 */
export function buildBindKeyArgs(options: BuildBindKeyOptions = {}): TmuxBindArgv[] {
  const kobeBin = options.kobeBin && options.kobeBin.length > 0 ? options.kobeBin : "kobe"
  return DEFAULT_KEYBINDINGS.map((b) => bindKeyArgvFor(b, kobeBin))
}

function bindKeyArgvFor(def: KeybindingDef, kobeBin: string): TmuxBindArgv {
  if (def.action.kind === "rpc") {
    const cmd = buildRunShellCommand(kobeBin, def.action.verb, def.action.args)
    return ["bind-key", "-n", "-T", "root", def.key, "run-shell", cmd]
  }
  return ["bind-key", "-n", "-T", "root", def.key, "select-pane", `-${def.action.direction}`]
}

/**
 * Compose the single shell-string argument tmux's `run-shell` takes.
 * `run-shell` accepts ONE argument that it passes to /bin/sh -c, so
 * we concatenate `<kobeBin> rpc <verb> [args] --no-wait` with spaces.
 * `--no-wait` is appended on every rpc binding so a slow daemon never
 * blocks the chord.
 *
 * Exported for unit-test introspection.
 */
export function buildRunShellCommand(kobeBin: string, verb: string, args: readonly string[]): string {
  const parts = [kobeBin, "rpc", verb, ...args, "--no-wait"]
  return parts.join(" ")
}
