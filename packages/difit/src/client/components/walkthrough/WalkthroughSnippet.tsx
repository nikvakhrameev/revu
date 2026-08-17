import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { DifitRef } from '@revu/plan-schema';

import {
  type CommentThread,
  type DiffChunk as DiffChunkType,
  type DiffSide,
  type LineNumber,
} from '../../../types/diff';
import { DiffChunk } from '../DiffChunk';

import { StalePlaceholder } from './StalePlaceholder';
import {
  buildSnippetChunk,
  findDiffFile,
  getBlobLines,
  planSnippetSlice,
  synthesizeContextSegment,
} from './snippetChunk';
import { useWalkthroughContext } from './WalkthroughContext';

interface WalkthroughSnippetProps {
  refBlock: DifitRef;
  /** Marked stale by the wrapper (payload.stale) — render a placeholder. */
  isStale: boolean;
  /** Ordinal of the snippet within the page, used to keep DOM line ids unique. */
  snippetOrdinal: number;
}

type SnippetState =
  | { status: 'loading' }
  | { status: 'unresolved' }
  | { status: 'ready'; chunk: DiffChunkType };

const EMPTY_THREADS: CommentThread[] = [];

/**
 * Renders a difit-ref block as a live diff snippet: slices the referenced line
 * range out of the loaded diff chunks and fills ranges outside the hunks (or
 * whole unchanged files) with context lines synthesized from blob content.
 * Rendering goes through the regular DiffChunk / SideBySideDiffChunk, so
 * highlighting, word-level diff, split/unified and commenting behave exactly
 * like the full diff.
 */
export function WalkthroughSnippet({ refBlock, isStale, snippetOrdinal }: WalkthroughSnippetProps) {
  const {
    files,
    diffMode,
    syntaxTheme,
    baseCommitish,
    targetCommitish,
    threadsByFile,
    showAuthorBadges,
    onAddComment,
    onGenerateThreadPrompt,
    onRemoveThread,
    onReplyToThread,
    onRemoveMessage,
    onUpdateMessage,
    onOpenInEditor,
    onOpenInFullDiff,
  } = useWalkthroughContext();

  const side: DiffSide = refBlock.side ?? 'new';
  const file = useMemo(() => findDiffFile(files, refBlock.file, side), [files, refBlock.file, side]);
  const resolvedPath = file?.path ?? refBlock.file;

  const [state, setState] = useState<SnippetState>({ status: 'loading' });

  useEffect(() => {
    if (isStale) {
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });

    const resolve = async () => {
      const range = refBlock.lines;
      const plan = file
        ? planSnippetSlice(file, side, range)
        : { segments: [], missingRuns: [{ start: range.start, end: range.end }] };

      if (plan.missingRuns.length === 0) {
        const chunk = buildSnippetChunk(plan.segments);
        if (!cancelled) {
          setState(chunk ? { status: 'ready', chunk } : { status: 'unresolved' });
        }
        return;
      }

      const blobRef = side === 'old' ? baseCommitish : targetCommitish;
      const blobPath = side === 'old' ? (file?.oldPath ?? refBlock.file) : refBlock.file;
      if (!blobRef) {
        if (!cancelled) setState({ status: 'unresolved' });
        return;
      }

      try {
        const { lines: blobLines, totalLines } = await getBlobLines(blobPath, blobRef);
        if (cancelled) return;

        const segments = [...plan.segments];
        for (const run of plan.missingRuns) {
          if (run.end > totalLines) {
            setState({ status: 'unresolved' });
            return;
          }
          const segment = synthesizeContextSegment(file, side, run, blobLines);
          if (!segment) {
            setState({ status: 'unresolved' });
            return;
          }
          segments.push(segment);
        }

        const chunk = buildSnippetChunk(segments);
        setState(chunk ? { status: 'ready', chunk } : { status: 'unresolved' });
      } catch {
        if (!cancelled) setState({ status: 'unresolved' });
      }
    };

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [refBlock, file, side, baseCommitish, targetCommitish, isStale]);

  const handleAddComment = useCallback(
    (line: LineNumber, body: string, codeContent?: string, commentSide?: DiffSide) =>
      onAddComment(resolvedPath, line, body, codeContent, commentSide),
    [onAddComment, resolvedPath],
  );

  const handleOpenInFullDiff = useCallback(() => {
    onOpenInFullDiff(resolvedPath, side, refBlock.lines.start);
  }, [onOpenInFullDiff, resolvedPath, side, refBlock.lines.start]);

  const fileThreads = threadsByFile.get(resolvedPath) ?? EMPTY_THREADS;
  const snippetThreads = useMemo(() => {
    if (state.status !== 'ready') {
      return EMPTY_THREADS;
    }
    const oldNumbers = new Set<number>();
    const newNumbers = new Set<number>();
    state.chunk.lines.forEach((line) => {
      if (line.oldLineNumber !== undefined) oldNumbers.add(line.oldLineNumber);
      if (line.newLineNumber !== undefined) newNumbers.add(line.newLineNumber);
    });
    return fileThreads.filter((thread) => {
      const anchor = Array.isArray(thread.line) ? thread.line[1] : thread.line;
      return (thread.side ?? 'new') === 'old' ? oldNumbers.has(anchor) : newNumbers.has(anchor);
    });
  }, [fileThreads, state]);

  if (isStale || state.status === 'unresolved') {
    return (
      <StalePlaceholder
        filePath={resolvedPath}
        lines={refBlock.lines}
        side={refBlock.side}
        onOpenInFullDiff={handleOpenInFullDiff}
      />
    );
  }

  const rangeLabel =
    refBlock.lines.start === refBlock.lines.end
      ? `${refBlock.lines.start}`
      : `${refBlock.lines.start}-${refBlock.lines.end}`;

  return (
    <div
      className="my-3 border border-github-border rounded-md overflow-hidden bg-github-bg-primary"
      style={{ '--line-number-width': '4em' } as React.CSSProperties}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2 bg-github-bg-secondary border-b border-github-border">
        <div className="min-w-0 font-mono text-xs text-github-text-primary truncate">
          {resolvedPath}
          <span className="text-github-text-muted">
            :{rangeLabel}
            {side === 'old' ? ' (old)' : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={handleOpenInFullDiff}
          className="px-3 py-1.5 text-xs rounded border border-github-border text-github-text-secondary hover:text-github-text-primary hover:bg-github-bg-tertiary transition-colors whitespace-nowrap"
        >
          Open in full diff
        </button>
      </div>
      {state.status === 'loading' ? (
        <div className="px-4 py-3 text-sm text-github-text-secondary">Loading snippet...</div>
      ) : (
        <div className="overflow-x-auto">
          <DiffChunk
            chunk={state.chunk}
            chunkIndex={0}
            threads={snippetThreads}
            showAuthorBadges={showAuthorBadges}
            onAddComment={handleAddComment}
            onGenerateThreadPrompt={onGenerateThreadPrompt}
            onRemoveThread={onRemoveThread}
            onReplyToThread={onReplyToThread}
            onRemoveMessage={onRemoveMessage}
            onUpdateMessage={onUpdateMessage}
            mode={diffMode}
            syntaxTheme={syntaxTheme}
            fileIndex={-(snippetOrdinal + 1)}
            filename={resolvedPath}
            onOpenInEditor={onOpenInEditor}
          />
        </div>
      )}
    </div>
  );
}
