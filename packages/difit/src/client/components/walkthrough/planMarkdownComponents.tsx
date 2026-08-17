import React from 'react';

import { extractMarkdownText, isElementWithCodeProps, isSafeUrl } from '../../utils/markdownUtils';
import { PrismSyntaxHighlighter } from '../PrismSyntaxHighlighter';
import type { AppearanceSettings } from '../SettingsModal';

import { PAGE_LINK_PREFIX } from './planBody';

/**
 * Markdown component map for walkthrough plan pages. Mirrors the styling
 * approach of CommentBodyRenderer, plus interception of `#page:` links for
 * in-plan navigation. difit-ref fenced blocks never reach this renderer —
 * they are split out of the body beforehand (see planBody.ts).
 */
export const getPlanMarkdownComponents = (
  onNavigateToPage: (pageId: string) => void,
  syntaxTheme?: AppearanceSettings['syntaxTheme'],
) => ({
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="text-xl font-semibold mt-5 mb-2 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="text-lg font-semibold mt-5 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="text-base font-semibold mt-4 mb-1 first:mt-0">{children}</h3>
  ),
  h4: ({ children }: { children?: React.ReactNode }) => (
    <h4 className="text-sm font-semibold mt-4 mb-1 first:mt-0">{children}</h4>
  ),
  h5: ({ children }: { children?: React.ReactNode }) => (
    <h5 className="text-sm font-semibold mt-3 mb-1 first:mt-0">{children}</h5>
  ),
  h6: ({ children }: { children?: React.ReactNode }) => (
    <h6 className="text-sm font-semibold mt-3 mb-1 first:mt-0">{children}</h6>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-2 first:mt-0 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc pl-5 my-2 first:mt-0 last:mb-0 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal pl-5 my-2 first:mt-0 last:mb-0 space-y-0.5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-4 border-github-border pl-3 my-2 text-github-text-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-github-border" />,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const safeHref = href ?? '';
    if (safeHref.startsWith(PAGE_LINK_PREFIX)) {
      const pageId = safeHref.slice(PAGE_LINK_PREFIX.length);
      return (
        <a
          href={safeHref}
          onClick={(event) => {
            event.preventDefault();
            onNavigateToPage(pageId);
          }}
          className="text-sky-400 hover:text-sky-300 underline underline-offset-4"
        >
          {children}
        </a>
      );
    }
    if (!safeHref || !isSafeUrl(safeHref)) {
      return <span>{children}</span>;
    }
    const isExternal = safeHref.startsWith('http');
    return (
      <a
        href={safeHref}
        target={isExternal ? '_blank' : undefined}
        rel={isExternal ? 'noreferrer' : undefined}
        className="text-sky-400 hover:text-sky-300 underline underline-offset-4"
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }: { src?: string; alt?: string }) => {
    const safeSrc = src ?? '';
    if (!safeSrc || !isSafeUrl(safeSrc)) {
      return null;
    }
    return (
      <img
        src={safeSrc}
        alt={alt ?? ''}
        loading="lazy"
        className="max-w-full rounded border border-github-border"
      />
    );
  },
  pre: ({ children }: { children?: React.ReactNode }) => {
    const nodes = Array.isArray(children) ? children : [children];
    const codeElement = nodes.find(isElementWithCodeProps);
    const codeText = extractMarkdownText(codeElement ?? children);
    const match = /language-(\S+)/.exec(codeElement?.props.className ?? '');
    const language = match?.[1];
    const normalizedCodeText = codeText.replace(/\n$/, '');

    if (!codeText.trim()) {
      return (
        <pre className="my-2 rounded-md border border-github-border bg-github-bg-secondary p-3 overflow-x-auto text-xs leading-5">
          {children}
        </pre>
      );
    }

    return (
      <pre className="my-2 rounded-md border border-github-border bg-github-bg-secondary p-3 overflow-x-auto text-xs leading-5">
        <PrismSyntaxHighlighter
          code={normalizedCodeText}
          language={language}
          syntaxTheme={syntaxTheme}
          className="font-mono text-github-text-primary"
        />
      </pre>
    );
  },
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    if (className) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="px-1 py-0.5 rounded bg-github-bg-tertiary border border-github-border font-mono text-[85%]">
        {children}
      </code>
    );
  },
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2 first:mt-0 last:mb-0">
      <table className="border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-github-bg-secondary">{children}</thead>
  ),
  tbody: ({ children }: { children?: React.ReactNode }) => <tbody>{children}</tbody>,
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="border-b border-github-border">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-2 py-1 text-left font-semibold border border-github-border">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-2 py-1 border border-github-border">{children}</td>
  ),
});
