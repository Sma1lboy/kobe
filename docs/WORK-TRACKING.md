# Local work tracking

kobe work is tracked locally — there is no external issue tracker. Agents should not file or update tickets in any external system, or require its CLI authentication, during normal development.

## Sources of truth

- **Backlog + open issues**: daemon-owned issue state.
- **Current risks and follow-ups**: [`../HANDOFF.md`](../HANDOFF.md).
- **User-facing shipped behavior**: [`../packages/kobe/CHANGELOG.md`](../packages/kobe/CHANGELOG.md).
- **Durable product and architecture decisions**: `docs/*.md`.
- **Proof of work**: git commits and test output.

## Issues / backlog — daemon issue store

The daemon owns active issue state so web edits and agent automation see the
same data from every worktree. Deliberately low-ceremony: no type taxonomy,
just a `status`. The persisted daemon file is keyed by each repo's git
common-dir, so the source checkout and its worktrees share one issue record:

```json
{
  "version": 1,
  "repos": {
    "/path/to/repo/.git": {
      "repoRoot": "/path/to/repo",
      "nextId": 4,
      "issues": [
        { "id": 1, "title": "short imperative title", "status": "open", "created": "YYYY-MM-DD", "body": "context, repro, scope — one field, free text" }
      ]
    }
  }
}
```

- **`status`**: `open` → `doing` → `done`, plus `hold` for issues parked on purpose (waiting on a decision, blocked, deliberately deferred). `hold` is a parking lot, not a lifecycle step — resume by flipping back to `open`. The archive sweep ignores it (only `done` moves), so held issues stay visible in the active file. Status is still the only dimension; don't add label/type fields.
- **`id`**: take `nextId`, then increment `nextId`. Ids are never reused.
- **Adding**: use the web Issues page or `kobe api issue-create --repo <path> --title ...`. The daemon stores the repo's issue record under the repo's git common-dir, so a source checkout and its task worktrees share the same issues.
- **Closing**: flip `status` to `done`. Done issues stay visible in the Done column until a future archive/export flow exists.
- **Agent automation**: use `kobe api issue-list`, `kobe api issue-create`, `kobe api issue-set-status`, and `kobe api issue-update`. From a task worktree, `--repo .` resolves to the same daemon issue record as the source checkout.
- **Web panel**: the `kobe web` dashboard's Issues page proxies `/api/issues` to daemon `issue.*` RPCs (status flips incl. `hold`, new issues, one-click quick-start of a kobe task from an issue).

Code changes still land their user-facing line as a **Changeset** (see [`RELEASING.md`](./RELEASING.md)) — issues are the *backlog of what to do*, the changelog is the *record of what shipped*. They're different things; an issue often closes by landing a change that carries its own changeset.

## Local workflow

1. Read `HANDOFF.md` and the relevant docs before editing.
2. Check `git status --short` so user changes are not mistaken for agent changes.
3. Make a focused change.
4. Run the applicable checks from `docs/HARNESS.md`.
5. Update `CHANGELOG.md` for user-visible changes.
6. Commit when green, using the repository commit rules from `AGENTS.md`.

## Recording follow-ups

Use repo-local artifacts instead of external tickets:

- Backlog / "we should do X" items go in the daemon issue tracker.
- Immediate operational notes for the next session go in `HANDOFF.md`.
- Durable design notes go in `docs/`.
- Release-facing changes go in a Changeset → `CHANGELOG.md`.

If a future request needs external tracking again, ask the user first. Do not file external tickets automatically.
