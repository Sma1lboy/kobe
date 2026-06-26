---
repo:
  id: kobe
  name: kobe

portfolio:
  id: kobe
  name: kobe
  version: 1.0.0

version: 1.1.0

producer:
  id: gpt-image
  model: gpt-image-2
  params:
    seed_strategy: per_asset
    seed: 20260626
    quality: high
    timeout_seconds: 180
    retry_attempts: 2
    output_format: png
    background: opaque
    moderation: auto

global:
  color:
    ink: { $value: "#191713", $type: "color" }
    paper: { $value: "#F7F1E8", $type: "color" }
    mars-dust: { $value: "#B85D3D", $type: "color" }
    warm-stone: { $value: "#D8C8B0", $type: "color" }
    clay: { $value: "#D87857", $type: "color" }
    shell: { $value: "#EBBBAC", $type: "color" }
    graphite: { $value: "#3A342D", $type: "color" }
    copper: { $value: "#A85E34", $type: "color" }
    terminal: { $value: "#11161C", $type: "color" }
    signal-blue: { $value: "#2F6F9F", $type: "color" }
  typography:
    display-face:
      $value: "large crisp lowercase warm grotesk title typography, restrained tracking, highly legible launch copy"
      $type: "fontFamily"
    terminal-face:
      $value: "monospaced terminal UI typography, compact pane labels, readable task names, no fake paragraph walls"
      $type: "fontFamily"
  style-fragment:
    mars-field-computing:
      $value: "cinematic Mars field-computing launch image, rust-red Martian surface and pale dusty sky, rugged terminal workstation on a compact field table, suited adult mission operator using the terminal, rover hardware and cable harnesses in the midground, believable habitat equipment, tactile dust, hard sunlight, screen glow reflected subtly in the visor"
      $type: "text"
    clean-product-promo:
      $value: "restrained product launch poster for a terminal developer tool, no narrative scene, no characters, no props. Use a simple editorial composition: matte dark graphite background, one large real terminal product surface, warm clay accents, generous negative space, and a clear poster-like headline and subtitle lockup"
      $type: "text"
    tui-product-focus:
      $value: "use the provided kobe TUI screenshots as canonical product references. Preserve the actual layout language: full-height left task rail with KOBE version text, Working sessions and Archives tabs, one selected project row, keys legend footer; large central engine pane with pixel icon header, prompt area, and PR line; right column split into file tree above and shell pane below; thin tmux borders, dark graphite panels, clay-orange focus lines and labels, muted gray monospace text"
      $type: "text"
    warm-technical-palette:
      $value: "warm paper and stone background tones, Mars dust and clay highlights, graphite and ink terminal panels, copper hardware details, one restrained blue signal accent, quiet premium technology mood, not neon cyberpunk"
      $type: "text"
    launch-hierarchy:
      $value: "wide product hero card. Place the exact lowercase word \"kobe\" very large and poster-like, fully inside a top-left safe area with visible margin above and left of every letter. Put the secondary copy \"parallel agents, one terminal\" directly below it at smaller size. The real terminal screenshot is the dominant product surface, large enough to read as the actual kobe TUI, not a blurred prop"
      $type: "text"
    cinematic-craft:
      $value: "wide high-resolution hero image, pulled-back medium-wide camera rather than close-up, terminal screen is the dominant object, human operator is smaller in the right-side midground and occupies no more than about 22 percent of canvas width, helmet is much smaller than the terminal screen and does not touch the top or right frame edge, screen-first product framing, strong horizon silhouette, crisp visor reflection of terminal panes, tactile suit fabric, brushed metal workstation, controlled dust texture, sharp foreground, restrained atmospheric glow"
      $type: "text"
    product-craft:
      $value: "ordinary clean promotional image, product-first framing, screenshot shown in a precise terminal window or floating screen plane with subtle shadow, sharp foreground, crisp UI structure, restrained texture, no people, no planet, no hardware, no cinematic environment, no surreal elements"
      $type: "text"
  negative:
    global-exclude:
      $value: "cropped headline, cropped kobe wordmark, letters cut off at the frame edge, giant KOBE text touching the top edge, huge foreground astronaut helmet, faceplate filling the right side, person touching frame edges, terminal screen smaller than helmet, official Anthropic logo, standalone Claude logo outside the terminal UI, fake sponsor logos, basketball imagery, celebrity likeness, robot mascot, glossy SaaS cards, browser chrome, generic hologram dashboard, unreadable terminal gibberish, excessive neon, purple-blue gradient, crowded sci-fi HUD, malformed main headline, watermark"
      $type: "text"
    clean-exclude:
      $value: "cropped headline, cropped kobe wordmark, letters cut off at the frame edge, giant KOBE text touching the top edge, astronaut, Mars, moon, planet, lander, rover, rocket, helmet, human character, mission operator, robot mascot, official Anthropic logo, standalone Claude logo outside the terminal UI, fake sponsor logos, basketball imagery, celebrity likeness, glossy SaaS cards, browser chrome, generic hologram dashboard, unreadable terminal gibberish, excessive neon, purple-blue gradient, crowded sci-fi HUD, malformed main headline, watermark"
      $type: "text"
  reference:
    actual-tui: { $value: "packages/branding/marketing/references/kobe-tui-actual.png", $type: "asset" }
    clean-tui: { $value: "packages/branding/marketing/references/kobe-tui-clean.png", $type: "asset" }
    pane-grid: { $value: "packages/branding/marketing/references/pane-grid.png", $type: "asset" }
    bracket-chip: { $value: "packages/branding/marketing/references/bracket-chip.png", $type: "asset" }

alias:
  style:
    mars-launch-hero:
      $type: "composite"
      $value:
        prompt: "{global.style-fragment.mars-field-computing}, {global.style-fragment.tui-product-focus}, {global.style-fragment.warm-technical-palette}, {global.style-fragment.launch-hierarchy}, {global.style-fragment.cinematic-craft}"
        palette:
          - "{global.color.ink}"
          - "{global.color.paper}"
          - "{global.color.mars-dust}"
          - "{global.color.warm-stone}"
          - "{global.color.clay}"
          - "{global.color.shell}"
          - "{global.color.graphite}"
          - "{global.color.copper}"
          - "{global.color.signal-blue}"
        typography: "{global.typography.display-face}; {global.typography.terminal-face}"
        negative: "{global.negative.global-exclude}"
        references:
          - "{global.reference.actual-tui}"
          - "{global.reference.pane-grid}"
    clean-product-hero:
      $type: "composite"
      $value:
        prompt: "{global.style-fragment.clean-product-promo}, {global.style-fragment.tui-product-focus}, {global.style-fragment.warm-technical-palette}, {global.style-fragment.launch-hierarchy}, {global.style-fragment.product-craft}"
        palette:
          - "{global.color.ink}"
          - "{global.color.paper}"
          - "{global.color.warm-stone}"
          - "{global.color.clay}"
          - "{global.color.shell}"
          - "{global.color.graphite}"
          - "{global.color.terminal}"
          - "{global.color.signal-blue}"
        typography: "{global.typography.display-face}; {global.typography.terminal-face}"
        negative: "{global.negative.clean-exclude}"
        references:
          - "{global.reference.clean-tui}"
          - "{global.reference.bracket-chip}"
    launch-hero:
      $type: "composite"
      $value:
        prompt: "{global.style-fragment.clean-product-promo}, {global.style-fragment.tui-product-focus}, {global.style-fragment.warm-technical-palette}, {global.style-fragment.launch-hierarchy}, {global.style-fragment.product-craft}"
        palette:
          - "{global.color.ink}"
          - "{global.color.paper}"
          - "{global.color.warm-stone}"
          - "{global.color.clay}"
          - "{global.color.shell}"
          - "{global.color.graphite}"
          - "{global.color.terminal}"
          - "{global.color.signal-blue}"
        typography: "{global.typography.display-face}; {global.typography.terminal-face}"
        negative: "{global.negative.clean-exclude}"
        references:
          - "{global.reference.clean-tui}"
---

# kobe Brand Studio Theme

This theme is the source of truth for Brand Studio image prompts for kobe. Campaigns should describe product moments and campaign-specific content only; reusable visual grammar lives in the YAML frontmatter.

The Mars field-computing direction is intentionally limited to the `mars-launch-hero` alias because it is a requested campaign scene. The default launch/product aliases remain clean and product-first.
