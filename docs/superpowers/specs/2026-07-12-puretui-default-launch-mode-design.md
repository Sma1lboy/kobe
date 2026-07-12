# PureTUI default launch mode design

## Goal

Make the React PureTUI Workspace Host the default `kobe` interface while
keeping the tmux Handover workspace available through an explicit CLI flag.
Use one launch-mode contract across installed CLI usage and development
scripts, and remove the global `KOBE_TUI` environment switch.

## CLI contract

- Bare `kobe` launches PureTUI.
- `kobe --puretui` explicitly launches PureTUI.
- `kobe --tmux` launches the tmux Handover workspace.
- `--puretui` and `--tmux` are launch-only top-level flags. They do not alter
  subcommand behavior.
- Passing both launch flags is a usage error: print a clear conflict message,
  print top-level help, and exit with status 2 without starting either UI.
- Any unexpected argument in the launch-only position remains an unknown
  command and exits with status 2.
- `kobe --help` documents that PureTUI is the default and describes both
  launch flags.

## Architecture

The CLI owns argument parsing. It resolves a small explicit launch-mode value
(`"puretui" | "tmux"`) and passes it to `startTui(mode)`. The TUI bootstrap
selects the corresponding host from that value; it does not inspect
`process.argv` or mutate/read environment state.

Remove `nativeChatEnabled()` and every production, test, and documentation
reference to `KOBE_TUI`. There is no compatibility environment fallback:
PureTUI users no longer need the variable because it is the default, and tmux
users select their workspace with `--tmux`.

## Development scripts

- `bun run dev` forwards `--puretui` and `--tmux` to the same production CLI
  parser.
- `bun run dev:sandbox --puretui` and `bun run dev:sandbox --tmux` preserve the
  sandbox home/socket/port isolation and forward the selected launch flag.
- `dev:sandbox` without a launch flag follows the CLI default (PureTUI).
- Existing `dev:sandbox:reset` and sandbox `home` behavior remain unchanged;
  launch flags are valid only for the run mode.
- Version-reproduction startup uses the selected version's own CLI contract;
  this change does not retrofit flags into older releases.

## Documentation and release surface

Update all active documentation that calls PureTUI opt-in or tmux the default,
including top-level CLI help, README development examples, architecture
descriptions, keybinding scope notes, and relevant inline comments. Add a patch
changeset describing the new default and the explicit tmux escape hatch.

## Verification

- Unit tests pin launch-argument parsing: default PureTUI, explicit PureTUI,
  explicit tmux, conflicting flags, and unknown arguments.
- CLI dispatch tests assert that the resolved mode is passed to `startTui` and
  that conflict paths never start a UI.
- TUI bootstrap tests (or an equivalent pure selection seam) pin the mapping
  from launch mode to Workspace Host versus tmux Handover.
- Sandbox-script tests pin flag forwarding and reject launch flags for
  `reset`/`home` if those combinations are supplied.
- Help tests assert the PureTUI default plus both documented flags.
- Existing PureTUI behavior tests launch with `--puretui` rather than
  `KOBE_TUI=1`.
- Run the focused tests first, then the repository lint, typecheck, and full
  fast/socket test suite required by `docs/HARNESS.md`.
