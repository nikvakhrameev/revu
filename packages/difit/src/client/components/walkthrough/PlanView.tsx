import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { WalkthroughPayload } from '@revu/plan-schema';

import { PlanBanner } from './PlanBanner';
import { PlanPage } from './PlanPage';
import { TableOfContents } from './TableOfContents';
import { WalkthroughProvider, type WalkthroughContextValue } from './WalkthroughContext';

interface PlanViewProps {
  payload: WalkthroughPayload;
  context: WalkthroughContextValue;
}

/**
 * Full-screen walkthrough plan mode: table of contents, one page at a time,
 * prev/next navigation and a stale banner. The current page lives in in-tab
 * state only (always opens at the first page) and survives plan<->diff
 * toggling because the component stays mounted while a plan exists.
 */
export function PlanView({ payload, context }: PlanViewProps) {
  const pages = payload.plan.pages;
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const pageIndex = useMemo(() => {
    const index = pages.findIndex((page) => page.id === currentPageId);
    return index >= 0 ? index : 0;
  }, [pages, currentPageId]);
  const page = pages[pageIndex];

  const navigateToPage = useCallback(
    (pageId: string) => {
      if (pages.some((candidate) => candidate.id === pageId)) {
        setCurrentPageId(pageId);
      }
    },
    [pages],
  );

  // Scroll to top when the page changes.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [page?.id]);

  if (!page) {
    return null;
  }

  const previousPage = pageIndex > 0 ? pages[pageIndex - 1] : undefined;
  const nextPage = pageIndex < pages.length - 1 ? pages[pageIndex + 1] : undefined;

  return (
    <WalkthroughProvider value={context}>
      <div className="h-full flex flex-col bg-github-bg-primary">
        {payload.stale.length > 0 && <PlanBanner staleCount={payload.stale.length} />}
        <div className="flex flex-1 overflow-hidden">
          <TableOfContents
            planTitle={payload.plan.title}
            pages={pages}
            currentPageId={page.id}
            onSelectPage={navigateToPage}
          />
          <div ref={contentRef} className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto px-6 py-6">
              <div className="mb-4 pb-3 border-b border-github-border">
                <div className="text-xs text-github-text-muted">
                  Page {pageIndex + 1} of {pages.length}
                </div>
                <h2 className="mt-1 text-xl font-semibold text-github-text-primary">
                  {page.title}
                </h2>
              </div>

              <PlanPage page={page} onNavigateToPage={navigateToPage} />

              <nav className="mt-8 pt-4 border-t border-github-border flex items-center justify-between gap-4">
                {previousPage ? (
                  <button
                    type="button"
                    onClick={() => navigateToPage(previousPage.id)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary transition-colors min-w-0"
                  >
                    <ChevronLeft size={16} className="shrink-0" />
                    <span className="truncate">{previousPage.title}</span>
                  </button>
                ) : (
                  <span />
                )}
                {nextPage ? (
                  <button
                    type="button"
                    onClick={() => navigateToPage(nextPage.id)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm rounded border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary transition-colors min-w-0"
                  >
                    <span className="truncate">{nextPage.title}</span>
                    <ChevronRight size={16} className="shrink-0" />
                  </button>
                ) : (
                  <span />
                )}
              </nav>
            </div>
          </div>
        </div>
      </div>
    </WalkthroughProvider>
  );
}
