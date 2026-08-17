import { TriangleAlert } from 'lucide-react';

interface PlanBannerProps {
  staleCount: number;
}

/** Banner shown at the top of the plan when some snippet refs are stale. */
export function PlanBanner({ staleCount }: PlanBannerProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-github-border bg-github-bg-secondary text-github-warning text-sm">
      <TriangleAlert size={16} />
      <span>
        The diff has changed since this plan was generated — {staleCount}{' '}
        {staleCount === 1 ? 'snippet is' : 'snippets are'} stale.
      </span>
    </div>
  );
}
