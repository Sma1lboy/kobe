# PureTUI Replay ClaudeX Color Fidelity Design

## Problem

The native PureTUI replay capture launches the real Claude binary, but the
capture process currently inherits `NO_COLOR=1` from its parent environment.
Claude Code therefore emits no SGR color sequences. The resulting Brand Studio
video is monochrome even though terminal default-color negotiation works.

The previous acceptance check was insufficient: seeing a real Claude Code or
Codex process proves engine authenticity, but it does not prove that the Claude
color path matches a normal interactive `claudex` session.

## Evidence

A PTY probe launched the user's real `claudex` shell alias twice with the same
viewport and terminal protocol handlers:

- with inherited `NO_COLOR=1`: 0 SGR sequences and 0 color SGR sequences;
- with only `NO_COLOR` removed: 27 SGR sequences and 14 color SGR sequences,
  including Claude orange `rgb(215,119,87)` and multiple gray levels.

A later screen-level probe showed that `rgb(255,193,7)` belonged to the
repository-specific `PR #324` status link, not a portable warning state. The
portable acceptance frame therefore uses a real Claude Bash permission prompt:
Claude supplies the orange, gray, and periwinkle terminal palette while Kobe's
`permission_needed` task state supplies warning yellow `rgb(232,201,107)`.

This isolates the failure to the replay capture environment boundary.

## Chosen Design

### Environment isolation

The capture environment must remove `NO_COLOR` before launching the PureTUI,
daemon, PTY host, or engine children. It will continue to declare
`TERM=xterm-256color` and `COLORTERM=truecolor` explicitly.

The fix belongs in the capture-only environment builder. It must not change the
user's shell environment or Kobe's normal runtime environment.

### ClaudeX launch override

The capture CLI will accept an optional capture-only Claude engine command from
an environment variable. When set, it will write that command to the isolated
capture state as `engineCommand.claude` before the TUI starts.

The checked-in replay spec remains portable and contains no machine-specific
provider, model, or shell-alias configuration. For the reviewed Brand Studio
capture, the caller supplies the current `claudex` alias expansion. Kobe then
launches the same `cc-switch` provider and model path as the user's interactive
alias while preserving its normal engine-session wiring.

### Alternatives rejected

1. Hard-code `claudex` or its provider command in the replay JSON. This makes a
   checked-in production artifact depend on one machine's shell configuration.
2. Put a temporary executable named `claude` earlier on `PATH`. This can produce
   one corrected recording but leaves the capture API unable to reproduce it.
3. Only unset `NO_COLOR` and keep using bare `claude`. This repairs color but
   does not satisfy the requirement that the reviewed recording exercise the
   user's real `claudex` launch path.

## Data Flow

1. `capture-puretui.ts` builds the isolated demo root.
2. It writes normal capture state plus the optional Claude command override.
3. `puretui-terminal.ts` builds a sanitized child environment with `NO_COLOR`
   excluded and explicit truecolor terminal capabilities.
4. The source PureTUI creates a Claude task using `engineCommand.claude`.
5. The hosted PTY launches the expanded `claudex` command.
6. The headless terminal answers protocol queries, records the complete ANSI
   screen state, and writes refreshed `frames.json`.
7. Remotion renders the reviewed MP4 from those frames.

## Tests

Automated tests must prove:

- capture environment construction excludes inherited `NO_COLOR`;
- an unset Claude override leaves the existing state shape unchanged;
- a supplied Claude override is written only to isolated capture state;
- the replay regression suite remains green.

Manual acceptance must use the real `claudex` expansion and require a rendered
Claude permission frame containing visible Claude orange, Kobe permission-state
yellow, muted gray text, and the periwinkle permission selection on the dark
background. A monochrome frame fails acceptance even if the agent is real and
readable.

## Scope

This change is limited to `packages/branding` capture infrastructure, tests,
the refreshed replay frames, and rendered review artifacts. It does not alter
Kobe's normal engine defaults, global user state, provider configuration, or
shell aliases.
