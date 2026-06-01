# Local work tracking

kobe work is tracked locally — there is no external issue tracker. Agents should not file or update tickets in any external system, or require its CLI authentication, during normal development.

## Sources of truth

- **Backlog + open issues**: [`issues.json`](./issues.json) (resolved ones archived to [`issues-archive.json`](./issues-archive.json)).
- **Current risks and follow-ups**: [`../HANDOFF.md`](../HANDOFF.md).
- **User-facing shipped behavior**: [`../packages/kobe/CHANGELOG.md`](../packages/kobe/CHANGELOG.md).
- **Durable product and architecture decisions**: `docs/*.md`.
- **Proof of work**: git commits and test output.

## Issues / backlog — `docs/issues.json`

A single committed JSON holds the active backlog. Deliberately low-ceremony: no
type taxonomy, just a `status`. Shape:

```json
{
  "nextId": 4,
  "issues": [
    { "id": 1, "title": "short imperative title", "status": "open", "created": "YYYY-MM-DD", "body": "context, repro, scope — one field, free text" }
  ]
}
```

- **`status`**: `open` → `doing` → `done`. That's the only dimension; don't add label/type fields.
- **`id`**: take `nextId`, then increment `nextId`. Ids are never reused (the counter lives on the active file even after archiving).
- **Adding**: append an object, bump `nextId`, commit. One JSON for everything — fine for a mostly-solo repo; if a parallel branch ever conflicts on the array, it's a trivial hand-merge.
- **Closing**: flip `status` to `done`. Leave it in place until the next archive sweep.
- **Archiving**: `bun run issues:archive` moves every `done` issue into `issues-archive.json` (newest first) and shrinks the active file. Run it periodically so `issues.json` stays small.

Code changes still land their user-facing line as a **Changeset** (see [`RELEASING.md`](./RELEASING.md)) — `issues.json` is the *backlog of what to do*, the changelog is the *record of what shipped*. They're different things; an issue often closes by landing a change that carries its own changeset.

## Local workflow

1. Read `HANDOFF.md` and the relevant docs before editing.
2. Check `git status --short` so user changes are not mistaken for agent changes.
3. Make a focused change.
4. Run the applicable checks from `docs/HARNESS.md`.
5. Update `CHANGELOG.md` for user-visible changes.
6. Commit when green, using the repository commit rules from `AGENTS.md`.

## Recording follow-ups

Use repo-local artifacts instead of external tickets:

- Backlog / "we should do X" items go in `issues.json`.
- Immediate operational notes for the next session go in `HANDOFF.md`.
- Durable design notes go in `docs/`.
- Release-facing changes go in a Changeset → `CHANGELOG.md`.

If a future request needs external tracking again, ask the user first. Do not file external tickets automatically.
