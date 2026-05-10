---
name: infocard
description: Create editorial-style information cards using HTML/CSS in Markdown. Best for knowledge summaries, data highlights, event announcements, and single-topic content cards with magazine-quality typography.
metadata:
  author: Infocard Generator is powered by Markdown Viewer — the best multi-platform Markdown extension (Chrome/Edge/Firefox/VS Code) with diagrams, formulas, and one-click Word export. Learn more at https://docu.md
---

# Infocard Generator

**Quick Start:** Analyze content (density × structure × mood) → Auto-sense tone for color palette → Pick a layout skeleton → Embed HTML directly in Markdown with `<style scoped>`.

## Critical Rules

### Rule 1: Direct HTML Embedding
**IMPORTANT**: Write info cards as direct HTML in Markdown. **NEVER** use code blocks (` ```html `). The HTML should be embedded directly in the document without any fencing.

### Rule 2: No Empty Lines in HTML Structure
**CRITICAL**: Do NOT add any empty lines within the HTML info card structure. Keep the entire HTML block continuous to prevent parsing errors.

### Rule 3: Content Analysis Before Layout
**REQUIRED**: Analyze content along three dimensions before designing:

**Density** (determines breathing rhythm):

| Density | Content Volume | Visual Treatment |
|---------|---------------|-----------------|
| Low | ≤ 50 words core | "Big-character" composition. One oversized element dominates. Generous whitespace. |
| Medium | 50–200 words | Hero + supporting panels. 2–3 main blocks with clear hierarchy. |
| High | 200+ words | Asymmetric multi-column grids. Primary/secondary/supporting blocks. Never equal-weight tiles. |

**Structure** (determines layout geometry):

| Structure | Signal | Layout Pattern |
|-----------|--------|---------------|
| Single point | One core concept | One anchor element dominates, rest recedes |
| Contrast | A vs B, old vs new | Split panel, two poles |
| Hierarchy | Layers build on each other | Stacked modules, pyramid |
| Flow | Sequential steps | Vertical cascade, numbered items |
| Radial | Core + derivatives | Hub with surrounding panels |
| Parallel | Multiple equal concepts | Asymmetric grid (never equal columns) |

**Mood** (determines color temperature):

| Mood | Visual Feel |
|------|------------|
| Reflective | More whitespace, serif-heavy, lower contrast |
| Sharp | Strong contrast, bold type, vivid accent |
| Warm | Earth tones, rounded feel, gentle rhythm |
| Technical | Monospace accents, grid-like density |

### Rule 4: Tone Sensing
**REQUIRED**: Auto-select color palette based on content topic. Scan content keywords and match the closest tone:

| Content Tone | Background | Accent | Trigger Keywords |
|---|---|---|---|
| Philosophical | `#FAF8F4` | `#7C6853` | cognition, thinking, meaning, philosophy, essence |
| Technical | `#F5F7FA` | `#3D5A80` | architecture, algorithm, system, API, code |
| Literary | `#FBF9F1` | `#6B4E3D` | story, narrative, writing, poetry, character |
| Scientific | `#F4F8F6` | `#2D6A4F` | experiment, data, research, paper, discovery |
| Business | `#F4F3F0` | `#2D6A4F` | market, strategy, growth, finance, investment |
| Creative | `#F6F3F2` | `#B8432F` | design, art, aesthetics, inspiration, creation |
| Default | `#FAFAF8` | `#4A4A4A` | When no clear match — prefer default over wrong match |

When a style template is explicitly chosen, its colors take precedence over tone sensing. Use tone sensing as the default when no style is specified.

### Rule 5: Title Protection
If the user provides a title explicitly, use it as-is for the main headline. Put editorial interpretation into subtitle, summary, or side modules. Do not silently rewrite the user's title.

### Rule 6: Typography Hierarchy
Maintain a clear type scale and use it consistently:
- Hero title: `32px–48px`, weight 700–900, tight letter-spacing (`-0.02em`)
- Subtitle / summary: `16px–20px`, weight 400–500
- Body text: `14px–16px`, weight 400, line-height `1.6–1.7`
- Meta / tags / captions: `11px–13px`, weight 500–700, uppercase with letter-spacing
- Body text color: never pure black — use `#1a1a1a`, `#333`, or `#4a4a4a`

### Rule 7: Visual Weight Distribution
At least one module should feel visually heavier than the others. Avoid making every panel use the exact same treatment. Differentiate through scale, background tone, typographic weight, or accent rules.

### Rule 8: Taste Rules (Anti-AI Checklist)
Before finalizing any card, check against these common AI-generated visual patterns:

**Layout:**
- **No centered hero** — Do not default-center titles. Prefer left-aligned or asymmetric
- **No equal-width tiles** — Three equal columns side by side is the #1 AI signature. Use `2fr 1fr`, asymmetric grids, or staggered layouts
- **No uniform panels** — At least one panel must differ in scale, weight, or treatment

**Typography:**
- **No pure black** `#000000` — Use off-black (`#1a1a1a`, `#2d2a26`) or warm/cool dark
- **No oversized-only hierarchy** — Build hierarchy with weight and color, not just font-size scaling

**Color:**
- **Max 1 accent color**, saturation < 80%
- **No neon gradients** — No purple-blue AI glow, no gradient-filled headlines
- **Consistent temperature** — Do not mix warm gray and cool gray in one card

**Content:**
- **No filler data** — Avoid `99.99%`, `50%`, `1234567`. Use organic numbers (`47.2%`, `3.8M`)
- **No AI phrasing** — Avoid "empower", "seamless", "unleash", "next-generation"

**Spacing:**
- Padding and margins must be mathematically precise, no awkward gaps
- Adjacent elements must be visually aligned

## Style Examples

Choose a visual family first, then pick the specific template inside that family. This keeps the library broad without forcing a flat 29-style scan every time.

### Style Families

#### Warm Editorial and Storytelling

Use when the card should feel reflective, human, narrative, or culturally textured.

| Style | File | Suitable For |
|---|---|---|
| **Editorial Warm** | [styles/editorial-warm.md](styles/editorial-warm.md) | Knowledge summaries, book notes, essays, analytical reports |
| **Customer Spotlight** | [styles/customer-spotlight.md](styles/customer-spotlight.md) | Customer stories, case studies, success recaps, brand narratives, adoption stories |
| **Sunset Warm** | [styles/sunset-warm.md](styles/sunset-warm.md) | Community recaps, event notes, lifestyle summaries, positive storytelling |
| **Midcentury** | [styles/midcentury.md](styles/midcentury.md) | Brand stories, retro-modern campaigns, culture notes, design narratives |

#### Soft Lifestyle and Teaching

Use when the card should feel calm, approachable, and low-pressure.

| Style | File | Suitable For |
|---|---|---|
| **Soft Neutral** | [styles/soft-neutral.md](styles/soft-neutral.md) | Lifestyle content, wellness, education, gentle branding, creative workshops |
| **Slate Chalk** | [styles/slate-chalk.md](styles/slate-chalk.md) | Teaching content, lessons, concept explanations, workshop notes |
| **Education Studio** | [styles/education-studio.md](styles/education-studio.md) | Teaching notes, course modules, learning summaries, workshop guides |

#### Paper, Research, and Governance

Use when the card should read like a memo, report, brief, or evidence summary.

| Style | File | Suitable For |
|---|---|---|
| **Paper Minimal** | [styles/paper-minimal.md](styles/paper-minimal.md) | Product notes, task summaries, meeting notes, clean documentation |
| **Lab Journal** | [styles/lab-journal.md](styles/lab-journal.md) | Research summaries, scientific explanations, medical content, academic papers |
| **Academic Paper** | [styles/academic-paper.md](styles/academic-paper.md) | Research abstracts, paper summaries, literature reviews, evidence-heavy explanations |
| **Policy Paper** | [styles/policy-paper.md](styles/policy-paper.md) | Governance notes, policy explainers, legal-adjacent summaries, internal rules |
| **Navy Formal** | [styles/navy-formal.md](styles/navy-formal.md) | Investor decks, executive briefs, quarterly reports, corporate proposals |
| **Japanese Minimal** | [styles/japanese-minimal.md](styles/japanese-minimal.md) | Brand narratives, cultural notes, quiet product essays, reflective announcements |
| **Clinical Brief** | [styles/clinical-brief.md](styles/clinical-brief.md) | Healthcare summaries, medical notes, patient education, clinical snapshots |

#### Business, Finance, and Trust

Use when the card should look operational, executive, or commercially credible.

| Style | File | Suitable For |
|---|---|---|
| **Corporate Clean** | [styles/corporate-clean.md](styles/corporate-clean.md) | Product launches, B2B briefs, executive summaries, formal reports, investor-facing materials |
| **Pitch Deck VC** | [styles/pitch-deck-vc.md](styles/pitch-deck-vc.md) | Fundraising cards, market opportunity snapshots, startup traction summaries |
| **Sales Room** | [styles/sales-room.md](styles/sales-room.md) | Pipeline reviews, account snapshots, deal strategy notes, revenue briefings |
| **Trust Center** | [styles/trust-center.md](styles/trust-center.md) | Security notes, compliance summaries, audit updates, trust-facing reports |
| **Partner Channel** | [styles/partner-channel.md](styles/partner-channel.md) | Partner briefs, alliance updates, channel motions, co-sell summaries |

#### Technical and Operational

Use when precision, systems language, or implementation detail needs to dominate.

| Style | File | Suitable For |
|---|---|---|
| **Tech Blueprint** | [styles/tech-blueprint.md](styles/tech-blueprint.md) | Technical specs, system design docs, architecture summaries, engineering plans |
| **Engineering Whiteprint** | [styles/engineering-whiteprint.md](styles/engineering-whiteprint.md) | Architecture notes, API briefs, implementation plans, technical whitepapers |
| **Terminal Green** | [styles/terminal-green.md](styles/terminal-green.md) | Infra status cards, CLI guides, incident notes, retro-computing topics |

#### Broadcast, Statement, and High-Contrast

Use when the card should announce, signal urgency, or land a strong visual punch.

| Style | File | Suitable For |
|---|---|---|
| **Bold Contrast** | [styles/bold-contrast.md](styles/bold-contrast.md) | Data highlights, KPI dashboards, event announcements |
| **News Broadcast** | [styles/news-broadcast.md](styles/news-broadcast.md) | Flash updates, report callouts, media briefings, public announcements |
| **Incident Desk** | [styles/incident-desk.md](styles/incident-desk.md) | Incident reviews, outage notes, postmortems, reliability updates |
| **Neo Brutalism** | [styles/neo-brutalism.md](styles/neo-brutalism.md) | Bold campaign cards, manifesto-style summaries, startup launches, punchy statements |
| **Swiss Grid** | [styles/swiss-grid.md](styles/swiss-grid.md) | Structured editorial layouts, design-forward reports, typographic statements |

#### Signature Visual Identities

Use when the visual identity itself is part of the message.

| Style | File | Suitable For |
|---|---|---|
| **Deep Night** | [styles/deep-night.md](styles/deep-night.md) | Entertainment, creative showcases, product reveals, gaming content |
| **Glassmorphism** | [styles/glassmorphism.md](styles/glassmorphism.md) | Premium product reveals, feature spotlights, event invites, future-facing showcases |

## Layout Skeletons

Choose the content structure family first, then select the specific wireframe. Layouts remain style-agnostic.

### Layout Families

#### Core Single-Topic Cards

Use when one thesis should dominate and supporting content should stay secondary.

| Layout | File | Best For |
|---|---|---|
| **Hero Card** | [layouts/hero-card.md](layouts/hero-card.md) | Single topic with title + summary + one supporting panel |
| **Quote Card** | [layouts/quote-card.md](layouts/quote-card.md) | Pull-quotes, mission statements, keynote quotes with attribution |
| **Split Panel** | [layouts/split-panel.md](layouts/split-panel.md) | Two-column layouts: main content + sidebar or left-right comparison |
| **Stacked Modules** | [layouts/stacked-modules.md](layouts/stacked-modules.md) | Multi-section vertical flow with mixed-weight blocks |

#### Metrics and Operational Readouts

Use when numbers, status, or operating signals need to be scanned quickly.

| Layout | File | Best For |
|---|---|---|
| **Metric Board** | [layouts/metric-board.md](layouts/metric-board.md) | KPI cards, performance dashboards, quarterly reviews, health checks, metric-driven announcements |
| **Financial Snapshot** | [layouts/financial-snapshot.md](layouts/financial-snapshot.md) | Revenue summaries, cash views, performance snapshots, unit economics |
| **Sales Brief** | [layouts/sales-brief.md](layouts/sales-brief.md) | Pipeline reviews, deal strategy, regional sales updates, revenue operations |
| **Terminal Window** | [layouts/terminal-window.md](layouts/terminal-window.md) | Status snapshots, command walkthroughs, incident updates, operational summaries |

#### Sequence, Roadmap, and Progression

Use when the reader needs stages, steps, or directional movement.

| Layout | File | Best For |
|---|---|---|
| **Timeline Flow** | [layouts/timeline-flow.md](layouts/timeline-flow.md) | Sequential steps, milestones, process stages with vertical timeline |
| **Station Workflow** | [layouts/station-workflow.md](layouts/station-workflow.md) | Detailed workflow breakdowns where each step carries structured attributes (input/process/output/gate/duration) |
| **Roadmap Board** | [layouts/roadmap-board.md](layouts/roadmap-board.md) | NOW / NEXT / LATER planning, strategic sequencing, phased rollouts |
| **Staircase Progression** | [layouts/staircase-progression.md](layouts/staircase-progression.md) | Maturity curves, phased scope accumulation, stepped build-up stories |
| **Funnel Stack** | [layouts/funnel-stack.md](layouts/funnel-stack.md) | Sales funnels, conversion flows, recruitment pipelines, decision narrowing |
| **Incident Review** | [layouts/incident-review.md](layouts/incident-review.md) | Postmortems, outage reviews, reliability incidents, remediation snapshots |

#### Comparison and Decision

Use when the card needs explicit trade-offs, prioritization, or side-by-side framing.

| Layout | File | Best For |
|---|---|---|
| **Pros & Cons** | [layouts/pros-cons.md](layouts/pros-cons.md) | Trade-off analysis, decision framing, risk vs upside, balanced evaluation |
| **Quadrant Matrix** | [layouts/quadrant-matrix.md](layouts/quadrant-matrix.md) | Priority mapping, risk-return framing, portfolio views, 2x2 classification |
| **Matrix Table** | [layouts/matrix-table.md](layouts/matrix-table.md) | MxN classification grids with two meaningful axes and archetype-labeled cells |
| **Comparison** | [layouts/comparison.md](layouts/comparison.md) | Side-by-side contrast, option framing, before/after or A/B comparisons |
| **Principle Grid** | [layouts/principle-grid.md](layouts/principle-grid.md) | Numbered tenets paired with anti-pattern and application contrast per card |

#### Grid and Inventory

Use when the card needs repeated modules, mixed-size tiles, or scan-friendly inventories.

| Layout | File | Best For |
|---|---|---|
| **Bento Grid** | [layouts/bento-grid.md](layouts/bento-grid.md) | Multi-topic overviews, feature showcases, mixed-size grid cells |
| **Badge Grid** | [layouts/badge-grid.md](layouts/badge-grid.md) | Feature lists, capability catalogs, skill inventories, benefit showcases |
| **Checklist Board** | [layouts/checklist-board.md](layouts/checklist-board.md) | Execution tracking, launch readiness, QA gates, operational checklists |

#### System and Relationship Mapping

Use when structure, adjacency, or network relationships matter more than sequence.

| Layout | File | Best For |
|---|---|---|
| **Architecture Map** | [layouts/architecture-map.md](layouts/architecture-map.md) | Layered systems, platform overviews, service boundaries, technical blueprints |
| **Layered Sidebar Map** | [layouts/layered-sidebar-map.md](layouts/layered-sidebar-map.md) | Layered stack flanked by context rails carrying cross-cut threads, KPIs, or value-chain anchors |
| **Radial Hub** | [layouts/radial-hub.md](layouts/radial-hub.md) | Ecosystem overviews, core-plus-features, hub-and-spoke relationships |

#### Document and Memo Logic

Use when the card should read like a structured brief with explicit sections.

| Layout | File | Best For |
|---|---|---|
| **Research Abstract** | [layouts/research-abstract.md](layouts/research-abstract.md) | Abstract-summary cards, study findings, evidence synthesis, paper snapshots |
| **Board Memo** | [layouts/board-memo.md](layouts/board-memo.md) | Executive updates, decision memos, quarterly board notes, leadership summaries |
| **Policy Memo** | [layouts/policy-memo.md](layouts/policy-memo.md) | Internal policy changes, governance decisions, process rules, guidance notes |
| **Education Module** | [layouts/education-module.md](layouts/education-module.md) | Lesson summaries, learning paths, workshop modules, teaching cards |
| **Healthcare Summary** | [layouts/healthcare-summary.md](layouts/healthcare-summary.md) | Clinical overviews, patient summaries, care snapshots, health education |

#### Governance, Risk, and Audit

Use when ownership, control status, and mitigation detail must be explicit.

| Layout | File | Best For |
|---|---|---|
| **Risk Register** | [layouts/risk-register.md](layouts/risk-register.md) | Risk tracking, mitigation planning, compliance reviews, program governance |
| **Compliance Audit** | [layouts/compliance-audit.md](layouts/compliance-audit.md) | Audit summaries, control reviews, security posture checks, compliance tracking |

#### Narrative and Stakeholder Updates

Use when the content is about people, teams, customers, or partner motion.

Primitive note: `org-update`, `customer-story`, and `partner-brief` now share a lightweight `card-brief-*` outer rhythm. Keep `news-bulletin` separate unless the structure is actually about relationship or stakeholder motion rather than headline cadence.

| Layout | File | Best For |
|---|---|---|
| **News Bulletin** | [layouts/news-bulletin.md](layouts/news-bulletin.md) | Breaking updates, digest cards, status bulletins, press-style recaps |
| **Org Update** | [layouts/org-update.md](layouts/org-update.md) | Team changes, hiring updates, ownership shifts, leadership communications |
| **Customer Story** | [layouts/customer-story.md](layouts/customer-story.md) | Case studies, before/after outcomes, customer wins, adoption narratives |
| **Partner Brief** | [layouts/partner-brief.md](layouts/partner-brief.md) | Alliance updates, co-sell notes, partner summaries, channel reviews |

### Family Alignment Notes

- Prefer existing family primitives before inventing new class names. Current aligned layout families include `card-doc-*`, `card-kpi-*`, `card-sequence-*`, `card-tile-*`, `card-map-*`, `card-compare-*`, `card-review-*`, `card-topic-*`, and `card-brief-*`.
- When a new layout clearly belongs to one of those families, vary geometry and modifiers first. Do not create a parallel primitive vocabulary for the same role.
- Explicit special cases remain intentionally separate: `quote-card`, `terminal-window`, `news-bulletin`, and the strongest identity-driven style themes such as `deep-night` and `glassmorphism`.
- If a layout or style only shares mood and not structure, document the family relationship in prose rather than forcing additional primitive convergence.

## Design Principles

### Space and Breathing Room
- Card padding: `32px–48px` from edges
- Module gaps: `16px–24px`
- Title area must have generous line-height (`1.1–1.3`) and clear separation from body
- Never crowd content against card edges

### Visual Accents
- Use `4px–6px` thick rules as section dividers or accent borders
- Use subtle tinted backgrounds (`rgba(0,0,0,0.03)` or style-specific tints) for secondary panels
- Accent colors should be restrained: one highlight color used for rules, tags, or key numbers
- Optional: `4%` noise overlay for paper texture (see style templates)

### Content Rhythm
- High-density cards: group into overview → core judgment → supporting modules → conclusion
- Ranking content: asymmetric hero + structured list (avoid equal tiles)
- Tutorial/analysis content: overview → core insight → detail blocks → boundary/caveats → summary

## Styling Reference

### Common Classes (shared across all styles)
- `.card-frame` — outer container with max-width and padding
- `.card` — main card surface with background, padding, and optional noise overlay
- `.card-meta` — meta line (category, date, version) in small uppercase
- `.card-title` — main headline
- `.card-subtitle` — secondary headline or summary
- `.card-bar` — thick accent rule divider
- `.card-body` — body text paragraph
- `.card-body.dropcap` — first paragraph with drop cap initial letter (editorial opening)
- `.card-highlight` — standalone short sentence (< 25 chars) with left accent border for key insights
- `.card-grid` — grid container; `.card-grid-2` for two columns
- `.card-panel` — content panel with border-top accent
- `.card-panel.heavy` — heavier panel with more padding
- `.card-panel.light` — lighter panel with thinner border
- `.card-panel-title` — panel heading in small uppercase
- `.card-panel-text` — panel body text
- `.card-item` — titled content block (label + description pair)
- `.card-item-label` — item title/label
- `.card-tag` — inline tag/badge
- `.card-stat` — oversized number/metric display
- `.card-stat-label` — label beneath a stat
- `.card-divider` — thin horizontal rule between sections
- `.card-footer` — bottom strip for source, attribution, or notes
- `.card-endmark` — end-of-content mark (∎) for editorial closure

### Rich Text Elements

**Drop cap** (first paragraph only — creates editorial opening ceremony):
```html
<p class="card-body dropcap">First paragraph text...</p>
```

**Highlight quote** (standalone insight, < 25 chars, with accent left border):
```html
<p class="card-highlight">Key insight phrase</p>
```

**Titled item** (label + description pairs, for structured lists):
```html
<div class="card-item">
  <p class="card-item-label">Item Title</p>
  <p class="card-panel-text">Item description text.</p>
</div>
```

**Section divider**:
```html
<div class="card-divider"></div>
```

**End mark** (editorial closure, placed at content end):
```html
<span class="card-endmark">∎</span>
```

## Best Practices

### Content Guidelines
1. **Direct embedding only** — Always embed HTML directly in Markdown, never use ` ```html ` code blocks
2. **No empty lines in structure** — Keep the entire HTML block continuous
3. **Judge density first** — Decide low/medium/high before picking layout
4. **Protect user titles** — Never silently rewrite a user-provided headline
5. **Balance visual weight** — At least one heavy block, one medium, one light
6. **Use type scale consistently** — Follow the size hierarchy defined above
7. **Accent with restraint** — One accent color, used sparingly for rules and highlights
8. **Fill space intentionally** — If a section looks empty, restructure hierarchy before adding filler content
