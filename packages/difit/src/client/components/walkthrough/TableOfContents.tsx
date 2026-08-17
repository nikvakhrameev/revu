import type { WalkthroughPage } from '@revu/plan-schema';

interface TableOfContentsProps {
  planTitle: string;
  pages: WalkthroughPage[];
  currentPageId: string;
  onSelectPage: (pageId: string) => void;
}

/** Sidebar listing all plan pages, with the current one highlighted. */
export function TableOfContents({
  planTitle,
  pages,
  currentPageId,
  onSelectPage,
}: TableOfContentsProps) {
  return (
    <aside className="w-64 shrink-0 border-r border-github-border bg-github-bg-secondary overflow-y-auto hidden md:block">
      <div className="px-4 py-3 border-b border-github-border">
        <div className="text-xs uppercase tracking-wide text-github-text-muted">Walkthrough</div>
        <div className="mt-1 text-sm font-semibold text-github-text-primary">{planTitle}</div>
      </div>
      <nav className="py-2">
        {pages.map((page, index) => {
          const isCurrent = page.id === currentPageId;
          return (
            <button
              key={page.id}
              type="button"
              onClick={() => onSelectPage(page.id)}
              aria-current={isCurrent ? 'page' : undefined}
              className={`w-full text-left px-4 py-1.5 text-sm transition-colors flex items-baseline gap-2 ${
                isCurrent
                  ? 'bg-github-bg-tertiary text-github-text-primary font-medium'
                  : 'text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary'
              }`}
            >
              <span className="text-xs text-github-text-muted shrink-0">{index + 1}.</span>
              <span className="min-w-0 break-words">{page.title}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
