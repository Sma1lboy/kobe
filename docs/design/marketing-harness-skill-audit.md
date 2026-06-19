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
- Make every mutating command explain its planned writes before it writes.
- Keep raw generated outputs ephemeral unless a human explicitly promotes them.

For kobe, the repo root should not gain a generic `workspace/` tree. Marketing
inputs and approved public assets should live under a declared package-owned
location. The likely kobe shape is:

```text
packages/branding/
  public/
    marketing/
      brand.lock.yaml
      campaigns/
      references/
      published/
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
  marketingRoot: packages/branding/public/marketing

brand:
  lock: packages/branding/public/marketing/brand.lock.yaml
  campaigns: packages/branding/public/marketing/campaigns
  references: packages/branding/public/marketing/references

artifacts:
  scratch: packages/branding/.harness/out
  approved: packages/branding/public/marketing/published
  retainRawRuns: false

policy:
  requireHumanApprovalBeforeRender: true
  requireHumanApprovalBeforePublish: true
  allowRemoteRuntimeFallback: false
  allowRootWorkspaceBootstrap: false
```

Scripts should receive this metadata path directly, for example:

```bash
harness validate --metadata packages/branding/marketing.harness.yaml
harness render --metadata packages/branding/marketing.harness.yaml --campaign launch
harness publish --metadata packages/branding/marketing.harness.yaml --campaign launch
```

## Bugs and design gaps to record during fixes

### 1. The installed skill is too heavy

The submodule brings a full harness repo into kobe:

```text
.agents/skills/marketing-harness/
  scripts/
  skills/
  src/
  tests/
```

That is heavier than the expected skill shape. A skill should be a thin
agent-facing layer: `SKILL.md`, small shell/Python adapter scripts, and maybe
fixtures. The product repo should not inherit the runtime source tree, test
suite, packaging layout, examples, and provider implementation as the skill
payload.

Why this is a bug:

- It makes a simple agent skill look like an embedded product dependency.
- The product repo now carries implementation surfaces it does not own.
- `src/` and tests inside the skill submodule create confusion about where
  fixes belong and what kobe is expected to maintain.
- It makes review harder: the useful skill interface is small, but the
  installed tree is large enough to hide side effects.

Expected fix:

- Publish or expose a slim skill artifact containing only `SKILL.md`, launcher
  scripts, metadata schema, and minimal examples.
- Keep the Python runtime as a separately versioned tool dependency.
- If the runtime must live nearby during development, make that a developer
  checkout mode, not the installed skill shape.
- Document the boundary: "skill adapter" versus "harness runtime".

### 2. Runtime resolution is not reproducible

The installed skill package does not contain the Python runtime. The launcher
searches for an ancestor repo, then an installed `harness`, then can run a
remote `uvx --from git+https://github.com/CodeFox-Repo/marketing-harness`
fallback.

Why this is a bug:

- The behavior depends on the local checkout shape.
- The remote fallback is not pinned by the product repo.
- An AI skill can silently run a newer runtime than the reviewed instructions.

Expected fix:

- Pin the runtime by submodule commit, package lock, or an explicit tool
  version in metadata.
- Disable remote runtime fallback unless metadata explicitly allows it.
- Record the runtime commit/version in `run.lock.json`.

### 3. CodeFox defaults leak into a generic skill

The skill instructions and CLI defaults point at
`workspace/products/codefox/codefox/...`.

Why this is a bug:

- It makes the skill look generic while still being CodeFox-shaped.
- Agents may run the wrong campaign or create the wrong directory tree.
- It blocks repos like kobe from using package-scoped brand assets.

Expected fix:

- Remove CodeFox defaults from the CLI.
- Require metadata or explicit `--brand` and `--campaign` paths.
- Keep CodeFox only as an example fixture.

### 4. The docs and CLI disagree on publish behavior

The skill instructions describe local review through the repo channel, but the
CLI defaults `publish` to the CDN channel.

Why this is a bug:

- A user or agent can publish to a higher-risk channel by omission.
- Review and cost policy is enforced by prose, not command semantics.

Expected fix:

- Make the safest local channel the default, or require `--channel`.
- Add a `plan` or `dry-run` command that prints exact writes and destinations.
- Require an explicit approval flag for live render and publish.

### 5. Bootstrap mutates too much state

The bootstrap script creates root-level directories, edits `.gitignore`,
appends LFS attributes, and has a destructive example-copy path.

Why this is a bug:

- A skill bootstrap should not reshape a product repo without a plan.
- Root-level `workspace/` is not acceptable for kobe.
- Deletion is especially unsafe for agent-driven workflows.

Expected fix:

- Make bootstrap create-only and metadata-driven.
- Never delete existing paths.
- Print a plan before mutating `.gitignore`, `.gitattributes`, or directories.

### 6. Output value is unclear

The current flow produces raw run outputs and snapshots, but the raw outputs are
not necessarily valuable long-term product artifacts.

Why this is a bug:

- Repos accumulate generated images, prompts, and run locks that may never ship.
- Reviewers cannot tell which files are approved assets versus scratch output.
- Published artifacts can carry internal prompts and sidecar content.

Expected fix:

- Treat raw outputs as scratch by default.
- Promote only human-approved final assets into the declared public artifact
  directory.
- Keep prompt-heavy run locks out of public assets unless explicitly approved.

### 7. The style producer is too weak to be the default

The local producer is deterministic scaffold logic. It extracts colors and
fills generic tokens, but it is not a real design producer.

Why this is a bug:

- It can create plausible-looking but low-value brand locks.
- It conflicts with the skill story that design judgment comes from a
  brand/frontend/visual design producer.

Expected fix:

- Rename local producer behavior to `scaffold`.
- Do not make it the default creative producer.
- Prefer ingesting a structured output from an explicit design producer.

### 8. The image provider contract is brittle

The provider locates a `gpt-image` command through environment, PATH, or a
Codex-home skill path, then crops generated results to the requested size.

Why this is a bug:

- The provider path is machine-local and hard to reproduce.
- Post-generation crop/resize can damage composition and text.
- Error classification relies on string matching.

Expected fix:

- Resolve providers through metadata.
- Make resize/crop policy explicit and opt-in.
- Record provider command, version, model, and exact post-processing steps.

### 9. Example assets have an LFS mismatch

The example directories contain `.gitattributes` rules for raster assets, but
the checked-in PNGs are not LFS pointers.

Why this is a bug:

- Cloning the submodule can warn that pointer files were expected.
- Parent repos may appear dirty or require workaround config.

Expected fix:

- Either migrate example binaries to real LFS objects or remove the LFS attrs
  from example fixtures.
- Verify a clean clone with Git LFS enabled and disabled.

### 10. Implicit invocation is too broad

The skill config allows implicit invocation even though render and publish can
spend money and mutate files.

Why this is a bug:

- A marketing skill has a higher side-effect profile than a pure advice skill.
- Agents need a narrower trigger boundary before spending API credits.

Expected fix:

- Keep read-only validation/proposal commands implicit if useful.
- Require explicit user intent for live render, publish, or bootstrap.

## Fix process

For every fix, record:

- The bug number above.
- The changed files.
- The before/after command behavior.
- Whether the command is read-only, local-mutating, networked, or publishing.
- The verification command and result.

Do not close this audit by saying "the skill works" in general. Close items
only when the concrete behavior is pinned by code, metadata, and verification.
