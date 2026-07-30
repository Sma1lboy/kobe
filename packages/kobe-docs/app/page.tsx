import Link from 'next/link';

// The docs home IS the quick start: /docs renders content/docs/index.mdx,
// which sync-docs.mjs copies from docs/QUICKSTART.md. Static-export-friendly
// redirect via meta refresh.
export default function HomePage() {
  return (
    <main className="flex flex-col flex-1 items-center justify-center gap-4 text-center">
      <meta httpEquiv="refresh" content="0;url=/docs" />
      <p className="text-fd-muted-foreground">
        Redirecting to the{' '}
        <Link href="/docs" className="font-medium text-fd-primary underline">
          kobe docs
        </Link>
        …
      </p>
    </main>
  );
}
