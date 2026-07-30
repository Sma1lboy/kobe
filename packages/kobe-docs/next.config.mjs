import { createMDX } from 'fumadocs-mdx/next';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  // Static export has no /_next/image optimizer endpoint; serve images as-is.
  images: { unoptimized: true },
  // Bun's isolated linker symlinks packages into the root .bun store, so
  // Turbopack's root must be the monorepo root — otherwise it rejects
  // next/package.json as outside the project. outputFileTracingRoot also
  // overrides NEXT_PRIVATE_OUTPUT_TRACE_ROOT, which `vercel build` sets to
  // this package dir and which would re-break Turbopack's root inference.
  outputFileTracingRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  turbopack: {
    root: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  },
};

export default withMDX(config);
