---
name: recent-release
description: Render kobe's recent releases as a self-contained, kobe-styled HTML page (Chinese by default). Reads shipped notes from packages/kobe/CHANGELOG.md + git tags, filters to user-facing changes, and emits one standalone .html file in the `claude` theme (terracotta on near-black, JetBrains Mono, terminal chrome). Use when the user asks for a "release page", "发版速览", "recent release html", "把发版做成网页", or wants to share/post what changed.
metadata:
  internal: true
---

# Recent Release Page (kobe)

Turns recent kobe releases into a **single self-contained HTML file** styled like the product itself — the `claude` theme palette, JetBrains Mono, a terminal title bar, FEAT/FIX tags. It is the shareable, human-facing companion to [`changelog-generator`](../changelog-generator/SKILL.md) (which writes the machine-consumed Changesets). This skill only *renders*; it never edits `CHANGELOG.md` or changesets.

Default output language is **Chinese (zh-CN)** — kobe's default. Switch to English only if the user asks.

## When to use

- "做一份发版速览 / release page / 把最近几个版本做成网页 / recent release html".
- The user wants to share or post what shipped (a page they can open in a browser or attach).
- After cutting one or more releases, to produce a readable summary page.

Do NOT use this to draft changelog entries — that's `changelog-generator`. This skill consumes already-shipped notes.

## Inputs

- **Version range.** Default: the releases from **today** plus any from the last ~2–3 days so "几个发版" has content (kobe ships multiple releases/day — see the `main moves fast` reality). If the user names a range ("0.7.34 → 0.7.37", "最近 5 个版本", "今天的"), honor it exactly.
- **Language.** Default zh-CN. `en` on request.
- **Output path.** Default `kobe-release-notes-zh.html` at the repo root (`-en` suffix for English). Honor an explicit path.

## How to build

1. **Gather the releases.** Read the top of [`packages/kobe/CHANGELOG.md`](../../../packages/kobe/CHANGELOG.md) for the version sections in range. Cross-check dates with `git log --pretty="%h %ad %s" --date=short | grep -i "chore: release"` so each version gets its real release date and "today" is correct (the env's `currentDate` is the reference for "today").
2. **Filter to user-facing.** Keep features, visible behaviour changes, bug fixes the user can feel, packaging/install changes. **Drop** entries the changeset marked internal — anything starting `Internal:` / `Internal (web):` / pure refactor / test-only / "No behavior change". Same bar as `changelog-generator`'s Filtering section: "would a user reading github.com/Sma1lboy/kobe/releases care?"
3. **Classify each kept entry** as `FEAT` (new capability) or `FIX` (bug/behaviour fix). Map from the verb: "Add/新增" → FEAT, "Fix/修复" → FIX. Internal-but-shipped tooling (e.g. `kobe export`) is FEAT.
4. **Translate to natural Chinese** (unless `en`). Keep code identifiers, CLI commands, key chords, file paths, and the version numbers verbatim — only prose is translated. Render key chords with the `.kbd` style, code with `<code>`.
5. **Fill the template.** Copy [`assets/template.html`](assets/template.html) and replace the marked regions; [`assets/example.html`](assets/example.html) is a complete worked output (0.7.34 → 0.7.37) — match its density and voice. The newest version gets the `today` badge (`<span class="ver-badge today">今天</span>`); older versions get a plain date. Keep the styling block byte-for-byte — it encodes the real `claude` theme values; do not invent colors.
6. **Write the file** to the output path and tell the user how to open it (suggest `! open <path>` so it runs in their session). Do not auto-commit unless asked.

## Style contract (do not drift)

The look IS the product. The `<style>` block in `assets/template.html` is the source of truth and uses the real kobe `claude` theme values from `src/tui/context/theme/claude.json`:

- Background `#141413`, raised `#1A1917`, inset `#2B2A27`; primary/accent terracotta `#CC785C`, secondary `#D4967E`.
- FEAT green `#9ACA86`, FIX blue `#61AAF2`, error/red `#D47563`, yellow `#E8C96B`.
- Font: JetBrains Mono (the TUI/web font), loaded from Google Fonts.
- Chrome: a three-dot terminal title bar, a blinking-cursor brand line, BOLD CAPS section headers, dense two-line entries with a fixed-width FEAT/FIX tag column on the left.

If kobe changes its default theme, re-derive these from `claude.json` rather than hard-coding new guesses.

## What to avoid

- ❌ Editing `CHANGELOG.md` or `.changeset/*` — this skill is read-only over release notes.
- ❌ Inventing colors or fonts — pull from the template / `claude.json`.
- ❌ Including `Internal:` / refactor / test-only entries — they're noise on a human page.
- ❌ Multi-file output or external asset links — the page must be a single openable `.html` with no network deps except the Google Fonts link.
- ❌ English by default — kobe's default is Chinese.
