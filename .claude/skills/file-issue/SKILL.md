---
name: file-issue
description: File a kobe requirement or bug into Linear from a free-form description plus any screenshots in the conversation. Use when the user says "提个需求", "提个 bug", "记一下这个需求", "file an issue", "把这个提到 Linear", or pastes a screenshot and asks to log it as work.
---

# file-issue — turn a request into a Linear issue

The user drops a requirement, a bug, or a screenshot and wants it
captured as a Linear issue without manually writing the body, choosing
the team, or running the upload commands. This skill does all of that.

kobe code-level work is tracked in Linear — team `KOB`, project
`Pre-1.0 整理`, workspace `codesfox`. See the repo `CLAUDE.md` §"Issue
tracking — Linear" for the full contract.

## Triggers

- "提个需求 / 提个 bug / 记一下这个需求 / 把这个提到 Linear"
- "file an issue / log this as a bug / capture this requirement"
- A pasted screenshot + "记录下" / "log this" / "提需求通道"

If the request is tool/process/meta work (CLAUDE.md / skill / agent
config edits), it does **not** belong in Linear — say so and skip.
Litmus test: *does this change kobe's behavior, code, or product
surface?* Yes → file. No → skip.

## Steps

### 1. Classify

- **Feature** — new capability, enhancement, product follow-up.
- **Bug** — something broken or behaving wrong.
- Other valid labels: `Chore`, `Doc`, `Tech Debt`, `Featurebase`.

Pick the label from the user's wording; if genuinely ambiguous, ask.

### 2. Gather material

- **Description** — the user's request, in their own words. Don't
  invent scope they didn't ask for.
- **Requester** — if the user names who asked (e.g. "narwhal 提的"),
  record it. If not given, don't block on it — just omit.
- **Screenshots** — any image the user pasted this turn is cached at
  `/Users/jacksonc/.claude/image-cache/<uuid>/<n>.png`. The image's
  real path is shown in the conversation as
  `[Image: source: <path>]` right after the pasted image. Collect
  every such path — they get attached after the issue is created.
- **Code pointers** — if you can quickly identify the relevant file(s)
  (a grep, not a deep investigation), name them in an "实现备注" /
  "Implementation notes" section so the future implementer starts warm.
  Do NOT implement anything — this skill only files.

### 3. Write the body

Write to `/tmp/issue-body.md`. Match the user's language (Chinese in →
Chinese body). Structure:

```markdown
## 需求 / Bug

<the request, faithfully — what and why>

提出人：<requester, if known>

## 当前行为

<how it works today, if relevant — for bugs: repro + actual result>

## 期望行为

<what it should do>

## 实现备注

<file paths / existing infra to reuse, if you found any — optional>

## 开放问题

<anything left undecided — optional>
```

Drop sections that don't apply. Keep it tight; this is a ticket, not a
design doc.

### 4. Create the issue

```bash
linear issue create \
  --team KOB --project "Pre-1.0 整理" \
  --title "<short imperative title>" \
  --description-file /tmp/issue-body.md \
  --label "Feature" --no-interactive
```

- Title: short, imperative, in the user's language.
- `--label` is `Feature` or `Bug` (or whichever fits step 1).
- Always `--description-file`, never inline `-d` (mangles newlines).

### 5. Attach screenshots

For each image path collected in step 2:

```bash
linear issue attach KOB-N "/Users/jacksonc/.claude/image-cache/<uuid>/<n>.png"
```

`linear issue attach <issueId> <filepath>` uploads the file and creates
the attachment. Run once per image.

### 6. Surface the result

Print the issue URL and a one-line summary of what was filed
(title, label, requester, # of screenshots attached).

## Notes

- Filing is invisible and non-negotiable for code-level work — never
  ask "want me to file this?". The only decision is the litmus test.
- This skill **files only**. It never edits code or implements the
  request, even if the fix is obvious.
- If `linear` is missing on PATH or auth fails, surface it to the user
  — do not fall back to the Linear MCP.
- The keyring warning (`Failed to read keyring`) is harmless — the CLI
  still works via the cached/`LINEAR_API_KEY` credential.
