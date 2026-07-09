---
name: release
description: Autonomously cut a kobe (`@sma1lboy/kobe`) release end-to-end — detect the semver bump from pending changesets (flagging an upstream `minor` you didn't intend), run the release gates, bump/tag/push via `scripts/release.sh`, then poll the GitHub Actions Release workflow with `gh` until npm publish completes, diagnosing CI failures (npm token, registry 404, lint, branch mismatch) instead of leaving them silent. Use when the user says "cut a release", "ship a version", "release kobe", "发版", "release.sh", or "bump the version". Never force-pushes; always verifies the release landed on `main`.
metadata:
  internal: true
---

# Release kobe

Autonomous release driver for `@sma1lboy/kobe`. This is the supervised loop the
manual flow in [`docs/RELEASING.md`](../../../docs/RELEASING.md) describes — read
that doc once if anything here is ambiguous; it is the source of truth and this
skill must never contradict it.

The job is: **detect the bump → gate → bump/tag/push → watch CI → confirm
published, or stop with a precise report.** Do the whole chain without
hand-holding, but stop and surface (never guess) at the two human-judgment gates
marked **⚠ ASK** below.

## Hard rules (non-negotiable)

- **Never force-push.** No `git push -f`, no `--force-with-lease`, no
  `git reset --hard` on a shared branch, no retag-over-existing. If a tag or push
  conflicts, stop and report — recovery is the user's call.
- **Bump default is `patch`.** Per CLAUDE.md: pre-1.0 kobe ships features as
  patches. A `minor`/`major` only happens when the user *explicitly* said so this
  turn, OR a pending changeset already carries that bump — and the second case is
  exactly the trap to flag (see Step 1).
- **Release lands on `main` only.** Verify branch before *and* after. A release on
  a stray feature branch is the #1 historical failure — catch it early.
- **No `--no-verify`, no skipping hooks.** If a gate fails, fix the cause or stop.
- The release commit is `chore: release — X.Y.Z`. No AI/Claude attribution
  anywhere (commit, tag, GitHub release body).

## Step 0 — Preflight

Confirm the working tree is sane and you're where you think you are:

```bash
git rev-parse --abbrev-ref HEAD          # MUST be main (see Step 3)
git status --porcelain                    # working tree must be clean
git fetch origin && git log --oneline origin/main..HEAD   # any unpushed commits?
git log --oneline HEAD..origin/main       # are we behind? if so, surface — don't auto-merge
gh auth status                            # gh must be authed for CI polling
```

`scripts/release.sh` itself refuses a dirty tree (except the files it rewrites),
but do this first so you fail fast with a clear message instead of mid-script.

If `origin/main` is ahead of HEAD, **stop and surface** — kobe main moves fast
(often several releases/day); releasing from a stale base is how versions
collide. Let the user decide whether to pull/rebase.

## Step 1 — Detect the bump (and flag the surprise minor) ⚠ ASK

The bump is **not** chosen by you — it's the max of the pending `.changeset/*.md`
bump types, computed by `changeset version`. Inspect before consuming:

```bash
bun run changeset:status                  # shows pending changesets + resulting bump
ls .changeset/*.md | grep -v README.md    # raw list
# read each one — the first line frontmatter is the bump type:
#   ---
#   "@sma1lboy/kobe": minor      ← THIS is the bump that file forces
#   ---
```

Then decide:

- **No pending changesets** → nothing to release. `release.sh` will abort. Tell
  the user and offer to draft one (the `changelog-generator` skill does this).
- **All pending are `patch`** → proceed silently; this is the normal case.
- **Any pending is `minor` or `major`** → **⚠ STOP AND ASK.** This is the
  documented annoyance: an upstream/peer changeset silently promotes the release
  to a minor the user didn't intend. Quote the offending file + its bump line and
  confirm: *"`.changeset/foo.md` carries a `minor` — the release will be X.(Y+1).0,
  not a patch. Intended?"* Only continue on an explicit yes. Do **not** edit
  someone's changeset bump without permission.

Record the predicted next version (current `packages/kobe/package.json` version
applied with the detected bump) so you can verify it later.

## Step 2 — Run the gates locally (abort on failure)

The push-triggered CI gate is typecheck + unit tests + build, and **does not run
lint** (release.yml comment + RELEASING.md both say so). So run lint locally — a
lint regression won't block publish on its own, but it'll redden `ci.yml` and rot
main. Run all five; abort the release on any failure:

```bash
bun run lint
bun run typecheck
bun run test            # fast Vitest + unix-socket daemon/bridge suite
bun run build
cd packages/kobe && bun run perf:golden   # golden perf doctor (~25s, sandbox pty-host; docs/HARNESS.md §Performance contracts)
```

`perf:golden` ceilings are 2-3× the reference numbers, so a FAIL means a real
structural regression (startup, PTY spawn/wake, per-tab memory, park reclaim)
— treat it like a red test, not jitter; rerun once to confirm before digging.

Do **not** run `bun run test:behavior` as a release gate — it needs tmux + node-pty
+ a real `claude` binary and is intentionally excluded from CI. Only run it if the
release itself is a user-visible TUI behavior change and the user asks.

If a gate fails: report the exact failing command + output, fix it if it's an
obvious in-scope issue (and re-run the full set), or stop. Never proceed to tag a
red tree.

## Step 3 — Verify branch, then bump/tag/push

```bash
git rev-parse --abbrev-ref HEAD     # MUST print: main
```

If not on `main`, **stop** — do not `checkout`/`merge` to "fix" it autonomously
(concurrent sessions + branch juggling is the documented git-tangle failure).
Surface the actual branch and ask.

On `main` with gates green, run the release script. It is the single source of the
bump→version→CHANGELOG→commit→tag→push sequence — don't reimplement those steps by
hand:

```bash
scripts/release.sh
```

What it does (don't fight it): `changeset version` → `bun install` +
`--frozen-lockfile` → `lint:fix` on the regenerated JSON → commits
`chore: release — X.Y.Z` → tags `vX.Y.Z` → **prompts** before pushing `main` + tag.

- Confirm the printed `CURRENT → NEW (vX.Y.Z)` matches your Step 1 prediction. A
  mismatch means a changeset changed under you — stop and re-inspect.
- The script asks `Push now? [y/N]`. Answer `y` only after the version line checks
  out. If the user wanted a dry run / review-before-push, answer `N` and report the
  staged commit + tag so they can push manually.

The push of tag `vX.Y.Z` is what triggers `.github/workflows/release.yml`.

## Step 4 — Poll CI until publish completes

The tag push starts the **Release** workflow (`publish` job: gates → npm publish →
GitHub release; then `binaries` matrix). Watch it to terminal state — don't
declare success on push alone:

```bash
gh run list --workflow=release.yml --limit 5          # find the run for this tag
gh run watch <run-id> --exit-status                    # blocks until done; nonzero on failure
# or poll:  gh run view <run-id> --json status,conclusion,jobs
```

On success, verify the package actually landed (don't trust the green check alone):

```bash
npm view @sma1lboy/kobe@<new-version> version          # must echo the new version
gh release view v<new-version> --json name,assets -q '.assets[].name'   # binaries attached?
```

Confirm: published version == tag == `packages/kobe/package.json`, release landed
on `main` (`git log --oneline -1 origin/main` is the `chore: release` commit),
binaries for darwin-arm64 / linux-x64 / linux-arm64 are attached. Then report
done with the version, the npm dist-tag it went to (`latest` for plain semver), and
the release URL.

## Step 5 — Diagnose CI failure (auto-fix or stop precisely)

If the run fails, identify the job + step before doing anything:

```bash
gh run view <run-id> --log-failed
```

Map the failure to a cause and act. **Never** retry blindly or force-push.

| Symptom in the log | Likely cause | Action |
|---|---|---|
| `npm publish` → `401`/`403`, `ENEEDAUTH`, `EOTP` | `NPM_TOKEN` secret missing/expired/wrong scope | Code is fine and the tag is published-or-not — **stop and report**. Token rotation is the user's job (Settings → secrets → `NPM_TOKEN`, automation token with `@sma1lboy` publish rights). After they fix it, a re-publish needs a *new* version (npm won't overwrite) — never retag the same version. |
| `npm publish` → `404` on registry / scope | registry URL or scope access wrong | Report; check `.npmrc` auth line + `access: public`. Don't mutate published state. |
| `Verify tag matches package.json` step fails | tag ≠ `package.json` version (retag drift) | Means the tag and the committed version disagree — surface it; do **not** force-retag. The fix is to bump+commit then tag fresh, which is the user's call. |
| Typecheck / test / build red | real regression that local gates somehow missed | Reproduce locally (`bun run typecheck|test|build`), fix in-scope, and note that the tag already pushed — a fix needs a **new** patch release, not a force-push over the tag. |
| `npm publish` → `E409`/`cannot publish over` | version already on npm | The version is already out — likely a double-run. Stop; the next release is a new version. |
| `binaries` job fails but `publish` succeeded | runner/compile flake on one arch | npm already has the package. Report which arch is missing; the matrix can be re-run with `gh run rerun <run-id> --failed` (re-running binary upload is safe — `action-gh-release` is idempotent on the tag; re-running `publish` is NOT, it'll hit E409). |

The principle: anything that *changes published artifacts or rewrites history*
(retag, force-push, republish) is **stop-and-report**, not auto-fix. Anything
local and idempotent (re-run a flaky binary matrix, fix a lint/type error for the
*next* release) you may do.

## Prerelease note

For `vX.Y.Z-<id>.N` tags (e.g. `v0.7.0-experimental.0`), the workflow publishes to
the npm dist-tag named after the identifier (`experimental`), so `latest` stays
stable. These come from Changesets prerelease mode (`changeset pre enter <id>` …
`changeset pre exit`), not `release.sh`. If the user asks for a prerelease, follow
RELEASING.md's prerelease section rather than this default flow.
