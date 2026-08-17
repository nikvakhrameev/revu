import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import type { WalkthroughPage } from '@revu/plan-schema';

import { splitPlanBody } from './planBody';
import { getPlanMarkdownComponents } from './planMarkdownComponents';
import { StalePlaceholder } from './StalePlaceholder';
import { useWalkthroughContext } from './WalkthroughContext';
import { WalkthroughSnippet } from './WalkthroughSnippet';

const PLAN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

interface PlanPageProps {
  page: WalkthroughPage;
  onNavigateToPage: (pageId: string) => void;
}

/**
 * Renders one plan page: markdown segments through react-markdown (with
 * `#page:` link interception) and difit-ref blocks as live snippets.
 */
export function PlanPage({ page, onNavigateToPage }: PlanPageProps) {
  const { staleRefs, syntaxTheme } = useWalkthroughContext();

  const parts = useMemo(() => splitPlanBody(page.body), [page.body]);
  const markdownComponents = useMemo(
    () => getPlanMarkdownComponents(onNavigateToPage, syntaxTheme),
    [onNavigateToPage, syntaxTheme],
  );
  const stalePageRefIndexes = useMemo(
    () =>
      new Set(
        staleRefs.filter((stale) => stale.pageId === page.id).map((stale) => stale.refIndex),
      ),
    [staleRefs, page.id],
  );

  return (
    <div className="text-github-text-primary text-sm leading-6">
      {parts.map((part, index) => {
        if (part.type === 'markdown') {
          if (!part.content.trim()) {
            return null;
          }
          return (
            <div key={index}>
              <ReactMarkdown remarkPlugins={PLAN_REMARK_PLUGINS} components={markdownComponents}>
                {part.content}
              </ReactMarkdown>
            </div>
          );
        }

        if (!part.ref) {
          return (
            <StalePlaceholder
              key={index}
              filePath="(invalid reference)"
              message="This code reference could not be parsed"
            />
          );
        }

        return (
          <WalkthroughSnippet
            key={index}
            refBlock={part.ref}
            isStale={stalePageRefIndexes.has(part.refIndex)}
            snippetOrdinal={part.refIndex}
          />
        );
      })}
    </div>
  );
}
