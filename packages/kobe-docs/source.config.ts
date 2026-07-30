import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    // Turn ```mermaid fences into <Mermaid chart="…" /> MDX components.
    remarkPlugins: [remarkMdxMermaid],
    rehypeCodeOptions: {
      // docs/ uses fences Shiki doesn't bundle (e.g. ```tmux)
      fallbackLanguage: 'text',
      themes: {
        light: 'vitesse-light',
        dark: 'vesper',
      },
    },
  },
});
