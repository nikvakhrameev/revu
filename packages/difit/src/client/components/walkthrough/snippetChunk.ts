import {
  type DiffChunk,
  type DiffFile,
  type DiffLine,
  type DiffSide,
  type ExpandedLine,
} from '../../../types/diff';
import { fetchFileContent } from '../../hooks/useExpandedLines';

/**
 * Utilities to slice a sub-range of lines out of a file's diff chunks (by old-
 * or new-side line numbers) and to synthesize context lines from blob content
 * for ranges that fall outside the diff hunks. The result is a single
 * DiffChunk that renders through the existing DiffChunk / SideBySideDiffChunk
 * components exactly like the full diff.
 */

export interface SnippetLineRange {
  start: number;
  end: number;
}

interface SliceSegment {
  /** First requested-side line number of the segment, used for ordering. */
  firstSideNumber: number;
  lines: DiffLine[];
}

export interface SnippetSlicePlan {
  segments: SliceSegment[];
  /** Requested-side sub-ranges not covered by any diff hunk. */
  missingRuns: SnippetLineRange[];
}

const isContentLine = (line: DiffLine): boolean => line.type !== 'hunk' && line.type !== 'header';

const sideNumber = (line: DiffLine, side: DiffSide): number | undefined =>
  side === 'old' ? line.oldLineNumber : line.newLineNumber;

/**
 * Slice the file's chunks down to the lines whose requested-side number falls
 * in [start, end]. Opposite-side-only lines (e.g. delete lines when slicing by
 * the new side) are kept when they are adjacent to a kept line, so paired
 * modifications render whole and word-level diff keeps working.
 */
export function planSnippetSlice(
  file: DiffFile,
  side: DiffSide,
  range: SnippetLineRange,
): SnippetSlicePlan {
  const covered = new Set<number>();
  const segments: SliceSegment[] = [];

  for (const chunk of file.chunks) {
    const lines = chunk.lines;
    const keep: boolean[] = new Array(lines.length).fill(false);

    lines.forEach((line, index) => {
      if (!isContentLine(line)) return;
      const n = sideNumber(line, side);
      if (n !== undefined && n >= range.start && n <= range.end) {
        keep[index] = true;
      }
    });

    // Attach opposite-side-only runs that touch a kept line.
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line || !isContentLine(line) || sideNumber(line, side) !== undefined) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < lines.length) {
        const runLine = lines[j];
        if (!runLine || !isContentLine(runLine) || sideNumber(runLine, side) !== undefined) {
          break;
        }
        j += 1;
      }
      const prevKept = i > 0 && keep[i - 1] === true;
      const nextKept = j < lines.length && keep[j] === true;
      if (prevKept || nextKept) {
        for (let k = i; k < j; k += 1) {
          keep[k] = true;
        }
      }
      i = j;
    }

    const kept: DiffLine[] = [];
    let firstSideNumber: number | undefined;
    lines.forEach((line, index) => {
      if (!keep[index]) return;
      kept.push(line);
      const n = sideNumber(line, side);
      if (n !== undefined) {
        covered.add(n);
        if (firstSideNumber === undefined) {
          firstSideNumber = n;
        }
      }
    });

    if (kept.length > 0) {
      segments.push({ firstSideNumber: firstSideNumber ?? range.start, lines: kept });
    }
  }

  const missingRuns: SnippetLineRange[] = [];
  let runStart: number | null = null;
  for (let n = range.start; n <= range.end; n += 1) {
    if (!covered.has(n)) {
      if (runStart === null) runStart = n;
    } else if (runStart !== null) {
      missingRuns.push({ start: runStart, end: n - 1 });
      runStart = null;
    }
  }
  if (runStart !== null) {
    missingRuns.push({ start: runStart, end: range.end });
  }

  return { segments, missingRuns };
}

/**
 * Map a requested-side line number that lies outside every hunk to its
 * counterpart on the other side, using the cumulative old/new offset of the
 * hunks that end before it.
 */
export function counterpartLineNumber(file: DiffFile, side: DiffSide, lineNumber: number): number {
  let delta = 0; // new minus old
  for (const chunk of file.chunks) {
    const chunkEnd = side === 'old' ? chunk.oldStart + chunk.oldLines : chunk.newStart + chunk.newLines;
    if (chunkEnd <= lineNumber) {
      delta = chunk.newStart + chunk.newLines - (chunk.oldStart + chunk.oldLines);
    } else {
      break;
    }
  }
  return side === 'old' ? lineNumber + delta : lineNumber - delta;
}

/**
 * Build a context-lines segment from blob content for a range outside the diff
 * hunks (or for a file that is not part of the diff at all).
 * Returns null when the range exceeds the blob.
 */
export function synthesizeContextSegment(
  file: DiffFile | undefined,
  side: DiffSide,
  run: SnippetLineRange,
  blobLines: string[],
): SliceSegment | null {
  const lines: DiffLine[] = [];
  for (let n = run.start; n <= run.end; n += 1) {
    const content = blobLines[n - 1];
    if (content === undefined) {
      return null;
    }
    const counterpart = file ? counterpartLineNumber(file, side, n) : n;
    const line: ExpandedLine = {
      type: 'normal',
      content,
      oldLineNumber: side === 'old' ? n : counterpart,
      newLineNumber: side === 'old' ? counterpart : n,
      isExpanded: true,
    };
    lines.push(line);
  }
  return { firstSideNumber: run.start, lines };
}

/** Merge slice segments (diff + synthesized) into a single renderable chunk. */
export function buildSnippetChunk(segments: SliceSegment[]): DiffChunk | null {
  const ordered = [...segments].sort((a, b) => a.firstSideNumber - b.firstSideNumber);
  const lines = ordered.flatMap((segment) => segment.lines);
  if (lines.length === 0) {
    return null;
  }

  const oldNumbers = lines
    .map((line) => line.oldLineNumber)
    .filter((n): n is number => n !== undefined);
  const newNumbers = lines
    .map((line) => line.newLineNumber)
    .filter((n): n is number => n !== undefined);

  const oldStart = oldNumbers.length > 0 ? Math.min(...oldNumbers) : 0;
  const newStart = newNumbers.length > 0 ? Math.min(...newNumbers) : 0;
  const oldLines = oldNumbers.length > 0 ? Math.max(...oldNumbers) - oldStart + 1 : 0;
  const newLines = newNumbers.length > 0 ? Math.max(...newNumbers) - newStart + 1 : 0;

  return {
    header: '',
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines,
  };
}

// Blob contents are immutable per (path, ref) within a session, so cache them
// across snippets and plan re-fetches.
const blobCache = new Map<string, Promise<{ lines: string[]; totalLines: number }>>();

export function getBlobLines(
  filePath: string,
  ref: string,
): Promise<{ lines: string[]; totalLines: number }> {
  const key = `${ref}:${filePath}`;
  const cached = blobCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = fetchFileContent(filePath, ref).catch((error: unknown) => {
    blobCache.delete(key);
    throw error;
  });
  blobCache.set(key, promise);
  return promise;
}

/** Find the diff file a ref points at (renamed files may be referenced by old path). */
export function findDiffFile(
  files: DiffFile[],
  refFile: string,
  side: DiffSide,
): DiffFile | undefined {
  const byPath = files.find((file) => file.path === refFile);
  if (byPath) {
    return byPath;
  }
  if (side === 'old') {
    return files.find((file) => file.oldPath === refFile);
  }
  return undefined;
}
