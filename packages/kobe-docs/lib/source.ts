import { docs } from 'collections/server';
import { loader, type LoaderOutput, type Meta, type Page } from 'fumadocs-core/source';

type DocEntry = (typeof docs)['docs'][number];
type MetaEntry = (typeof docs)['meta'][number];

// See https://fumadocs.dev/docs/headless/source-api for more info.
//
// Note on the cast: Bun's isolated linker installs two content-identical
// fumadocs-core instances (app-level and fumadocs-mdx's peer context), and
// TS loses the page-data type through loader()'s structural inference across
// the duplicate declarations. The runtime is unaffected; re-attach the
// collection entry types explicitly.
export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
}) as unknown as LoaderOutput<{
  page: Page<undefined, DocEntry>;
  meta: Meta<undefined, MetaEntry>;
  i18n: undefined;
}>;
