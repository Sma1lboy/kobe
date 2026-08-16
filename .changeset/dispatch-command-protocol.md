---
"@sma1lboy/rove": patch
---

`rove api` picks engines by COMMAND, not by a vendor enum.

`add` and `send --tab new` now take `--command` — an engine id from the new
`engine-list` verb, or a full command line Rove runs verbatim
(`--command "codex --search"`). The protocol Rove speaks to it (transcript
reader, workspace-trust pre-answer, first-message delivery) is derived from
the command's `argv[0]` rather than declared beside it, falling back to a
generic protocol that still launches and delivers. Nothing validates an
engine's flags: probe an unfamiliar CLI with `<cmd> --help` first.

- **`engine-list`** *(new, offline)*: every engine Rove can launch with the
  RAW command it runs, its display name, and its resolved protocol. Copy an
  entry into `--command` verbatim, or edit a flag first.
- **`fan-out` is removed** — parallel attempts live on `add --count N` (and
  `--agents claude:2,codex:1`), same `groupId` / `#i/N` / partial-failure
  contract as before.
- **`set-vendor` is removed**, replaced by **`set-command`**.
- Both removed verbs return `UNKNOWN_VERB` with the replacement in
  `nextCommandArgs` — no silent aliases.
- Custom engines are now named PRESETS: Settings → Engines → + Add engine
  also asks for the protocol (`engineProtocol.<id>`), so a wrapper around a
  built-in keeps history, trust, and delivery instead of degrading to generic.

Bundled agent skill bumped to v24 for the new vocabulary.
