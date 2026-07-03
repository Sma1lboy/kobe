# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** One glossary + one ADR directory at the root; the monorepo packages (`kobe`, `kobe-daemon`, `kobe-web`, `branding`) share the same domain language.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary. kobe's is strict: every core noun (Task, Worktree, Handover, ChatTab, Engine, …) has an "Avoid" list of banned synonyms, and a Retired section for vocabulary that no longer exists.
- **`docs/adr/`** — architecture decision records. Read the ADRs that touch the area you're about to work in.

If any of these files don't exist, proceed silently — the producer skill (`/grill-with-docs`) creates them lazily.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids (e.g. say **Task**, never "project"/"ticket"; say **Worktree**, never "workspace").

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (daemon owns web transport) — but worth reopening because…_

Also remember the repo-wide rule from `CLAUDE.md`: the docs are the source of truth — if docs and implementation disagree, surface the mismatch before widening scope.
