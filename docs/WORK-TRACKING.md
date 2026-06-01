# Local work tracking

kobe work is tracked locally — there is no external issue tracker. Agents should not file or update tickets in any external system, or require its CLI authentication, during normal development.

## Sources of truth

- **Current risks and follow-ups**: [`../HANDOFF.md`](../HANDOFF.md).
- **User-facing shipped behavior**: [`../packages/kobe/CHANGELOG.md`](../packages/kobe/CHANGELOG.md).
- **Durable product and architecture decisions**: `docs/*.md`.
- **Proof of work**: git commits and test output.

## Local workflow

1. Read `HANDOFF.md` and the relevant docs before editing.
2. Check `git status --short` so user changes are not mistaken for agent changes.
3. Make a focused change.
4. Run the applicable checks from `docs/HARNESS.md`.
5. Update `CHANGELOG.md` for user-visible changes.
6. Commit when green, using the repository commit rules from `AGENTS.md`.

## Recording follow-ups

Use repo Markdown instead of external tickets:

- Immediate operational notes go in `HANDOFF.md`.
- Durable design notes go in `docs/`.
- Release-facing changes go in `CHANGELOG.md`.

If a future request needs external tracking again, ask the user first. Do not file external tickets automatically.
