/**
 * sync-docs.mjs — copy the repo's user-facing Markdown from ../../docs/ into
 * this package's Fumadocs content directory (content/docs/, gitignored).
 *
 * The repo's docs/ folder stays the single source of truth. For each synced
 * page this script:
 *   1. injects frontmatter (`title:` from the first H1, which is then
 *      stripped from the body);
 *   2. rewrites relative links: synced pages become /docs/<slug> site paths,
 *      repo source files and non-synced docs become github.com blob URLs;
 *   3. copies quick-start.mdx to index.mdx so the docs home IS the quick
 *      start, and writes meta.json with the sidebar order.
 *
 * Output is deterministic — re-running sync on unchanged sources produces
 * byte-identical files.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageDir, '../..');
const docsSourceDir = join(repoRoot, 'docs');
const docsOutDir = join(packageDir, 'content/docs');
const assetsOutDir = join(packageDir, 'public/docs-assets');

const repoBlob = 'https://github.com/Sma1lboy/kobe/blob/main/';

/**
 * The sidebar, as ordered sections of `[docs/ source file, site slug]`.
 * This is the single source of truth: PAGES (what gets synced) is derived
 * from it, so a page can never be synced but missing from the sidebar.
 */
const SECTIONS = [
  {
    title: 'Getting started',
    pages: [
      ['QUICKSTART.md', 'quick-start'],
      ['CONCEPTS.md', 'concepts'],
      ['TUI.md', 'tui'],
      ['KEYBINDINGS.md', 'keybindings'],
    ],
  },
  {
    title: 'Using kobe',
    pages: [
      ['CLI.md', 'cli'],
      ['CONFIGURATION.md', 'configuration'],
      ['ENGINES.md', 'engines'],
      ['themes.md', 'themes'],
      ['SESSIONS.md', 'sessions'],
    ],
  },
  {
    title: 'Automating and extending',
    pages: [
      ['API.md', 'api'],
      ['PLUGIN-AUTHORING.md', 'plugins'],
      ['WORK-TRACKING.md', 'work-tracking'],
    ],
  },
  {
    title: 'Help',
    pages: [['TROUBLESHOOTING.md', 'troubleshooting']],
  },
];

/** docs/ source file → site slug, in sidebar order. */
const PAGES = new Map(SECTIONS.flatMap((section) => section.pages));

/** Case-insensitive lookup so `./Keybindings.md`-style links still resolve. */
const PAGE_BY_LOWER_NAME = new Map([...PAGES].map(([name, slug]) => [name.toLowerCase(), slug]));

function rewriteTarget(target) {
  // External URLs, absolute site paths, and pure anchors pass through.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return target;

  const hashIndex = target.indexOf('#');
  const anchor = hashIndex === -1 ? '' : target.slice(hashIndex);
  let path = hashIndex === -1 ? target : target.slice(0, hashIndex);

  // Classify the prefix before stripping it:
  //   `../x`   → repo-root relative (docs/ lives one level below the root)
  //   `docs/x` → repo-root relative, rooted at docs/
  //   `./x` / bare → relative to docs/
  let repoRelativeBase = 'docs/';
  if (path.startsWith('../')) {
    repoRelativeBase = '';
    path = path.replace(/^(?:\.\.\/)+/, '');
  } else if (path.startsWith('docs/')) {
    path = path.slice('docs/'.length);
  } else if (path.startsWith('./')) {
    path = path.slice('./'.length);
  }

  // Links between synced pages → site paths.
  const slug = PAGE_BY_LOWER_NAME.get(basename(path).toLowerCase());
  if (slug && !path.includes('/')) return `/docs/${slug}${anchor}`;

  // Repo source files → GitHub blob URLs. Bare `src/…` paths in docs are
  // relative to packages/kobe/ by repo convention (see AGENTS.md).
  if (path.startsWith('packages/') || path.startsWith('scripts/')) {
    return `${repoBlob}${path}${anchor}`;
  }
  if (path.startsWith('src/')) {
    return `${repoBlob}packages/kobe/${path}${anchor}`;
  }

  // Anything else repo-relative (non-synced docs, CONTRIBUTING.md, …) →
  // GitHub blob URL under the base it was written against.
  if (/\.mdx?$/i.test(path) || repoRelativeBase === '') {
    return `${repoBlob}${repoRelativeBase}${path}${anchor}`;
  }

  return target;
}

/**
 * Image targets stay repo-relative in docs/ (`assets/foo.png`, so they render
 * on GitHub). For the site they are rewritten to `/docs-assets/foo.png` and
 * the referenced files are copied into public/docs-assets/ below.
 */
function rewriteImageTarget(target) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return target;
  const path = target.startsWith('./') ? target.slice('./'.length) : target;
  if (path.startsWith('assets/')) {
    referencedAssets.add(path.slice('assets/'.length));
    return `/docs-assets/${path.slice('assets/'.length)}`;
  }
  return target;
}

/** docs/assets/… paths referenced by synced pages, relative to assets/. */
const referencedAssets = new Set();

function rewriteLinks(markdown) {
  return (
    markdown
      // Inline links: [text](target "optional title"). Image targets become
      // site paths via rewriteImageTarget.
      .replace(
        /(!?)\[([^\]]*)\]\((<)?([^)\s>]+)(>)?((?:\s+"[^"]*")?)\)/g,
        (match, bang, text, _open, target, _close, title) =>
          bang
            ? `![${text}](${rewriteImageTarget(target)}${title})`
            : `[${text}](${rewriteTarget(target)}${title})`,
      )
      // Reference-style definitions: [label]: target
      .replace(/^(\[[^\]]+\]:\s+)(\S+)/gm, (match, label, target) => `${label}${rewriteTarget(target)}`)
  );
}

/**
 * CommonMark autolinks (`<https://…>`) are not valid MDX — `<` starts JSX.
 * Convert them to explicit links outside fenced code blocks.
 */
function rewriteAutolinks(markdown) {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/<(https?:\/\/[^>\s]+)>/g, '[$1]($1)');
    })
    .join('\n');
}

function toMdxPage(markdown, sourceFile) {
  // Title comes from the first H1, which is then stripped from the body.
  const h1 = markdown.match(/^# (.+)$/m);
  if (!h1) throw new Error(`${sourceFile}: no H1 found to derive the page title`);
  const title = h1[1].trim();
  const body = markdown.replace(/^# .+\r?\n(?:\r?\n)*/m, '');

  const frontmatter = [
    '---',
    '# Generated by packages/kobe-docs/scripts/sync-docs.mjs from',
    `# docs/${sourceFile} — edit the source, not this file.`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    '---',
    '',
  ].join('\n');

  return `${frontmatter}${rewriteAutolinks(rewriteLinks(body))}`;
}

await mkdir(docsOutDir, { recursive: true });
let quickStart = null;
for (const [sourceFile, slug] of PAGES) {
  const markdown = await readFile(join(docsSourceDir, sourceFile), 'utf8');
  const page = toMdxPage(markdown, sourceFile);
  if (slug === 'quick-start') quickStart = page;
  await writeFile(join(docsOutDir, `${slug}.mdx`), page, 'utf8');
  console.log(`synced docs/${sourceFile} → content/docs/${slug}.mdx`);
}

// The docs home IS the quick start: /docs renders index.mdx.
await writeFile(join(docsOutDir, 'index.mdx'), quickStart, 'utf8');
console.log('synced docs/QUICKSTART.md → content/docs/index.mdx (docs home)');

// Fumadocs renders `---Title---` entries as sidebar section separators.
const meta = {
  title: 'kobe',
  pages: SECTIONS.flatMap((section) => [
    `---${section.title}---`,
    ...section.pages.map(([, slug]) => slug),
  ]),
};
await writeFile(join(docsOutDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
console.log('wrote content/docs/meta.json');

// Copy referenced docs/assets/ files into public/docs-assets/ so the
// rewritten /docs-assets/… image paths resolve on the static site.
for (const asset of [...referencedAssets].sort()) {
  const out = join(assetsOutDir, asset);
  await mkdir(dirname(out), { recursive: true });
  await copyFile(join(docsSourceDir, 'assets', asset), out);
  console.log(`copied docs/assets/${asset} → public/docs-assets/${asset}`);
}
