import { parseRefBlock, type DifitRef } from '@revu/plan-schema';

// Mirrors REF_FENCE_RE from @revu/plan-schema (refs.ts); the regex itself is
// not exported there. Ref parsing is delegated to parseRefBlock so the actual
// block semantics stay in one place.
const REF_FENCE_RE = /^```difit-ref[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

export type PlanBodyPart =
  | { type: 'markdown'; content: string }
  | { type: 'ref'; refIndex: number; ref: DifitRef | null };

/**
 * Split a plan page body into markdown segments and difit-ref blocks, keeping
 * the ordinal index of each ref (used to match stale markers).
 */
export function splitPlanBody(body: string): PlanBodyPart[] {
  const parts: PlanBodyPart[] = [];
  let lastIndex = 0;
  let refIndex = 0;

  for (const match of body.matchAll(REF_FENCE_RE)) {
    const start = match.index;
    if (start > lastIndex) {
      parts.push({ type: 'markdown', content: body.slice(lastIndex, start) });
    }
    const parsed = parseRefBlock(match[1] ?? '', `refs[${refIndex}]`);
    parts.push({ type: 'ref', refIndex, ref: parsed.ref });
    refIndex += 1;
    lastIndex = start + match[0].length;
  }

  if (lastIndex < body.length) {
    parts.push({ type: 'markdown', content: body.slice(lastIndex) });
  }

  return parts;
}

export const PAGE_LINK_PREFIX = '#page:';
