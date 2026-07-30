'use client';

import { useTheme } from 'next-themes';
import { use, useEffect, useId, useState } from 'react';

/**
 * Renders ```mermaid fences client-side (static-export safe).
 * Brand palette mirrored from app/global.css so diagrams read as kobe
 * in both themes: warm paper, bone/graphite ink, terracotta accents.
 */
export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return <MermaidContent chart={chart} />;
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

// Mermaid's color parser (khroma) has no oklch support, so the brand
// oklch values from app/global.css are baked to hex equivalents here.
const DARK = {
  background: 'transparent',
  primaryColor: '#131311',
  primaryBorderColor: '#c6785b',
  primaryTextColor: '#e8e6de',
  secondaryColor: '#171614',
  tertiaryColor: '#171614',
  lineColor: '#a09d93',
  textColor: '#e8e6de',
  clusterBkg: '#17161480',
  clusterBorder: '#25231e',
  edgeLabelBackground: '#11110f',
  nodeTextColor: '#e8e6de',
};

const LIGHT = {
  background: 'transparent',
  primaryColor: '#eeede8',
  primaryBorderColor: '#9b5237',
  primaryTextColor: '#292620',
  secondaryColor: '#e9e8e3',
  tertiaryColor: '#e9e8e3',
  lineColor: '#615d54',
  textColor: '#292620',
  clusterBkg: '#e9e8e399',
  clusterBorder: '#d6d4ce',
  edgeLabelBackground: '#f4f3f0',
  nodeTextColor: '#292620',
};

function MermaidContent({ chart }: { chart: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(cachePromise('mermaid', () => import('mermaid')));
  const dark = resolvedTheme !== 'light';

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    fontFamily: 'inherit',
    themeCSS: 'margin: 1.5rem auto 0;',
    theme: 'base',
    themeVariables: dark ? DARK : LIGHT,
  });

  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, () =>
      mermaid.render(id, chart.replaceAll('\\n', '\n')),
    ),
  );

  return (
    <div
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid-rendered SVG is the point
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
