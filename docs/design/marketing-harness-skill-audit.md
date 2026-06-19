# marketing-harness skill audit

Status: active audit
Date: 2026-06-19

This note tracks the problems found while integrating
`CodeFox-Repo/marketing-harness` as a skill submodule. It is intentionally
written as a maintainer checklist: when a fix lands, update the relevant item
with the commit or leave a short reason if the item is rejected.

## Kobe stance

The skill is primarily for AI agents, not for humans typing long commands.
That changes the interface contract:

- Do not rely on hard-coded product paths in scripts or instructions.
- Inject project-specific paths and policy through YAML or JSON metadata.
- Prefer one explicit metadata file over many positional CLI defaults.
- Keep the installed skill thin: instructions plus small adapter scripts.
- Avoid user-facing mutating commands for asset intake or promotion.
- Make every internal mutating helper explain its planned writes before it writes.
- Keep raw generated outputs ephemeral unless a human explicitly promotes them.
- Treat accepted assets as durable state for the next production cycle.

For kobe, the repo root should not gain a generic `workspace/` tree. Marketing
source inputs and approved public assets should live under declared
package-owned locations, but not the same one. The likely kobe shape is:

```text
packages/branding/
  marketing/
    brand.lock.yaml
    campaigns/
    plans/
    references/
    proposals/
    asset-state.yaml
    accepted.yaml
  public/marketing/
    <format-or-channel>/
      asset-state.yaml
    <approved assets and manifests>
  .harness/out/
```

The exact directory can change, but it must be supplied by metadata. The
marketing harness should not create root-level `workspace/`, `outputs/`,
`published/`, or `releases/` directories by default.

## Proposed metadata contract

The skill launcher should accept a metadata file that the agent can generate or
discover from the product repo:

```yaml
project:
  id: kobe
  root: .
  marketingRoot: packages/branding/marketing

organization:
  id: sma1lboy
  name: Sma1lboy

portfolio:
  id: kobe
  name: kobe
  version: 1.0.0

brand:
  lock: packages/branding/marketing/brand.lock.yaml
  campaigns: packages/branding/marketing/campaigns
  references: packages/branding/marketing/references

artifacts:
  scratch: packages/branding/.harness/out
  approved: packages/branding/public/marketing
  retainRawRuns: false

policy:
  requireHumanApprovalBeforeRender: true
  requireHumanApprovalBeforeStateUpdate: true
  allowRootWorkspaceBootstrap: false

state:
  plans: packages/branding/marketing/plans
  assetIndex: packages/branding/marketing/asset-state.yaml
  accepted: packages/branding/marketing/accepted.yaml
  directoryStateFile: asset-state.yaml

sources:
  assetRoots:
    - packages/branding/marketing
    - packages/branding/public/marketing
  relatedRepos: []
```

Agents may call bundled scripts as private helpers with this metadata path, but
the user-facing asset lifecycle is not a command surface. The intended loop is:

```text
brand state -> production plan -> generated candidates -> user acceptance ->
accepted state -> next production
```

## Bugs and design gaps to record during fixes

### Fix log

- 2026-06-19: Upstream skill/runtime patch started in the
  `marketing-harness` submodule. The skill adapter now supports metadata-first
  command expansion, defaults remote runtime fallback off, makes bootstrap
  dry-run/create-only by default, disables implicit invocation, requires
  `--brand` at the CLI boundary, and changes CLI publish default to `repo`.
- 2026-06-19: Verified the default packaged skill zip contains only the thin
  skill payload and does not include root `src/`, `tests/`, or `examples/`.
  Package smoke measured 15.2 KB.
- 2026-06-19: Added a packaging guard so top-level `src/` or `tests/` inside
  the skill payload is rejected; `scripts/`, `references/`, `assets/`, and
  `agents/` remain the intended skill directories.
- 2026-06-19: Split metadata defaults so source inputs live under
  `packages/branding/marketing` while only approved static assets and manifests
  land under `packages/branding/public/marketing`.
- 2026-06-19: Removed the submodule's root-level `src` runtime package in
  `marketing-harness` commit `857c663` and moved the retained runtime into
  `skills/marketing-harness/scripts/`. The skill now uses bundled scripts
  instead of ancestor checkout discovery, installed `harness`, or remote `uvx`
  fallback.
- 2026-06-19: Removed the Typer package entry point, pydantic/Pillow/boto3
  dependency shape, style proposal commands, regression command, CDN/release
  publishing, and implicit model requirement. `provider.model` is optional and
  is only passed through when a brand lock declares it.
- 2026-06-19: Moved the example from root `workspace/products/...` to
  `examples/codefox/packages/branding/marketing`, removed extra multi-product
  examples and stale LFS attributes, and reduced examples from 1.1 MB to
  116 KB. Default packaged skill zip is 29.8 KB and still excludes examples.
- 2026-06-19: Removed the user-facing asset `publish` command in
  `marketing-harness` commit `4de1ca9`. The skill now frames durable assets as
  `planning -> candidates -> user acceptance -> accepted.yaml state -> next
  production`; scratch outputs are not state.
- 2026-06-19: Added org/portfolio/repo/directory asset-state preflight in
  `marketing-harness` commit `ab5b658`. Before production, the skill can now
  read metadata-declared asset roots, `asset-state.yaml`, `accepted.yaml`, and
  related local repo state; package smoke measured 34,330 bytes and still
  excludes `src`, `tests`, and `examples`.
- Still open: kobe still vendors the maintainer checkout as a submodule, so
  root maintainer files such as `tests/`, `pyproject.toml`, and examples remain
  outside the installable payload. Replacing the submodule with only generated
  skill payload contents is a separate layout choice.

### 1. The installed skill is too heavy

The submodule brings a full harness repo into kobe:

```text
.agents/skills/marketing-harness/
  scripts/
  skills/
  tests/
  pyproject.toml
  uv.lock
```

That is heavier than the expected skill shape. A skill should be a thin
agent-facing layer: `SKILL.md`, small shell/Python adapter scripts, and maybe
fixtures. The product repo should not inherit the runtime source tree, test
suite, packaging layout, examples, and provider implementation as the skill
payload.

Why this is a bug:

- It makes a simple agent skill look like an embedded product dependency.
- The product repo now carries implementation surfaces it does not own.
- tests and maintainer files inside the skill submodule create confusion about
  where fixes belong and what kobe is expected to maintain.
- It makes review harder: the useful skill interface is small, but the
  installed tree is large enough to hide side effects.

Expected fix:

- Publish or expose a slim skill artifact containing only `SKILL.md`, launcher
  scripts, metadata schema, and minimal examples.
- Keep runtime code under `skills/marketing-harness/scripts/` if it is required
  for an installed skill.
- Keep maintainer tests and packaging out of the packaged skill artifact.
- Document the boundary: "installable skill payload" versus "maintainer
  checkout".

### 2. Runtime resolution was not reproducible

The installed skill package did not contain the Python runtime. The launcher
searched for an ancestor repo, then an installed `harness`, then could run a
remote `uvx --from git+https://github.com/CodeFox-Repo/marketing-harness`
fallback.

Why this is a bug:

- The behavior depends on the local checkout shape.
- The remote fallback is not pinned by the product repo.
- An AI skill can silently run a newer runtime than the reviewed instructions.

Fixed behavior:

- The launcher now runs the bundled `scripts/cli.py` from the installed skill.
- There is no ancestor discovery, PATH `harness` resolution, or remote `uvx`
  fallback.
- Direct `python3` validate/render dry-run smoke was verified.

### 3. CodeFox defaults leaked into a generic skill

The skill instructions and CLI defaults point at
`workspace/products/codefox/codefox/...`.

Why this is a bug:

- It makes the skill look generic while still being CodeFox-shaped.
- Agents may run the wrong campaign or create the wrong directory tree.
- It blocks repos like kobe from using package-scoped brand assets.

Fixed behavior:

- CodeFox defaults were removed from the command path.
- Metadata or explicit `--brand` and campaign paths are required.
- CodeFox remains only as a package-local example fixture under
  `examples/codefox/packages/branding/marketing`.

### 4. The asset publish command was the wrong state model

The skill instructions treated asset promotion as a command flow. Earlier
runtime behavior also had higher-risk publish channels. That does not match the
desired agent workflow, where assets should become durable only after planning,
production, and explicit user acceptance of exact candidates.

Why this is a bug:

- A user or agent can add assets by command instead of through reviewed
  production state.
- Review and cost policy is enforced by prose instead of lifecycle state.
- Generated scratch outputs can be mistaken for approved product assets.

Fixed behavior:

- The user-facing `publish` command was removed from the skill runtime.
- Durable assets flow through plan, generated candidates, explicit user
  acceptance, and `accepted.yaml`.
- Acceptance helpers can draft paths/checksums/manifests, but state updates
  still require the accepted candidate ids or file paths.

### 5. Bootstrap mutated too much state

The bootstrap script creates root-level directories, edits `.gitignore`,
appends LFS attributes, and has a destructive example-copy path.

Why this is a bug:

- A skill bootstrap should not reshape a product repo without a plan.
- Root-level `workspace/` is not acceptable for kobe.
- Deletion is especially unsafe for agent-driven workflows.

Fixed behavior:

- Bootstrap is create-only, metadata-driven, and dry-run by default.
- It never deletes existing paths.
- It no longer edits `.gitignore` or `.gitattributes`.

### 6. Output value was unclear

The current flow produces raw run outputs and snapshots, but the raw outputs are
not necessarily valuable long-term product artifacts.

Why this is a bug:

- Repos accumulate generated images, prompts, and run locks that may never ship.
- Reviewers cannot tell which files are approved assets versus scratch output.
- Accepted artifacts can accidentally carry internal prompts and sidecar
  content.

Fixed behavior:

- Treat raw outputs as scratch by default.
- Promote only human-accepted final assets into the declared public artifact
  directory.
- Record accepted assets in the declared state file for future production.
- Keep prompt-heavy run locks out of public assets unless explicitly accepted.

### 6a. State was too local to support org or repo families

The first accepted-state fix only modeled a current repo `accepted.yaml`. That
does not cover a real org/portfolio workflow where sibling products should
share visual direction, accepted examples, and directory-specific asset memory.

Why this is a bug:

- Repo A cannot reliably learn from Repo B/C assets through a short
  description.
- Asset history stays trapped in one accepted file instead of being readable by
  directory, product, portfolio, and org.
- Future banner, landscape, PPT, logo-theme, X/XHS, and social assets cannot
  build from the same global visual view.

Fixed behavior:

- Metadata now declares organization, portfolio, repo asset roots, directory
  state filename, and related repos.
- The read-only `state` preflight aggregates `asset-state.yaml`, `accepted.yaml`,
  local image counts, and related repo state before planning.
- Directory state is descriptive input for future production; it is not a
  user-facing command surface for adding assets.

### 7. The style producer was too weak to be the default

The local producer is deterministic scaffold logic. It extracts colors and
fills generic tokens, but it is not a real design producer.

Why this is a bug:

- It can create plausible-looking but low-value brand locks.
- It conflicts with the skill story that design judgment comes from a
  brand/frontend/visual design producer.

Fixed behavior:

- Built-in style proposal/promote commands were removed from the skill runtime.
- Agents should use an explicit local design skill or human-provided proposal,
  then validate and dry-run with marketing-harness.

### 8. The image provider contract was brittle

The provider locates a `gpt-image` command through environment, PATH, or a
Codex-home skill path, then crops generated results to the requested size.

Why this is a bug:

- The provider path is machine-local and hard to reproduce.
- Post-generation crop/resize can damage composition and text.
- Error classification relies on string matching.

Fixed behavior:

- `provider.model` is optional; the marketing skill does not maintain OpenAI
  model defaults.
- The provider command is still resolved locally through `gpt-image` or
  `HARNESS_SKILL_CLI_COMMAND`.
- Post-generation resize/crop was removed from marketing-harness.

### 9. Example assets had an LFS mismatch

The example directories contain `.gitattributes` rules for raster assets, but
the checked-in PNGs are not LFS pointers.

Why this is a bug:

- Cloning the submodule can warn that pointer files were expected.
- Parent repos may appear dirty or require workaround config.

Fixed behavior:

- Removed stale example `.gitattributes` rules while keeping the small example
  PNG references.
- Default package still excludes examples.

### 10. Implicit invocation was too broad

The skill config allowed implicit invocation even though render can spend money
and accepted-state updates mutate repo files.

Why this is a bug:

- A marketing skill has a higher side-effect profile than a pure advice skill.
- Agents need a narrower trigger boundary before spending API credits.

Fixed behavior:

- Skill metadata disables implicit invocation.
- Live render and accepted-state updates remain explicit user-intent workflows
  in `SKILL.md`.

## Fix process

For every fix, record:

- The bug number above.
- The changed files.
- The before/after lifecycle or command behavior.
- Whether the behavior is read-only, local-mutating, networked, or
  state-updating.
- The verification command and result.

Do not close this audit by saying "the skill works" in general. Close items
only when the concrete behavior is pinned by code, metadata, and verification.
