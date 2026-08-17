import { TriangleAlert } from 'lucide-react';

interface StalePlaceholderProps {
  filePath: string;
  lines?: { start: number; end: number };
  side?: 'old' | 'new';
  message?: string;
  onOpenInFullDiff?: (() => void) | undefined;
}

const formatLines = (lines?: { start: number; end: number }): string => {
  if (!lines) return '';
  return lines.start === lines.end ? `:${lines.start}` : `:${lines.start}-${lines.end}`;
};

/**
 * Placeholder rendered instead of a snippet when the referenced code is stale
 * or the reference no longer resolves against the loaded diff.
 */
export function StalePlaceholder({
  filePath,
  lines,
  side,
  message = 'Code changed since the plan was generated',
  onOpenInFullDiff,
}: StalePlaceholderProps) {
  return (
    <div className="my-3 border border-github-border rounded-md bg-github-bg-secondary px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-github-warning text-xs font-medium">
            <TriangleAlert size={14} />
            <span>{message}</span>
          </div>
          <div className="mt-1 font-mono text-sm text-github-text-primary truncate">
            {filePath}
            <span className="text-github-text-muted">
              {formatLines(lines)}
              {side === 'old' ? ' (old)' : ''}
            </span>
          </div>
        </div>
        {onOpenInFullDiff && (
          <button
            type="button"
            onClick={onOpenInFullDiff}
            className="px-3 py-1.5 text-xs rounded border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary transition-colors whitespace-nowrap"
          >
            Open in full diff
          </button>
        )}
      </div>
    </div>
  );
}
