import { extractPageLinks, extractRefBlocks, parseRefBlock } from './refs.js';
import type {
  DifitRef,
  PlanValidationError,
  PlanValidationResult,
  WalkthroughPlan,
} from './types.js';

const PAGE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PAGE_ID_MAX = 64;

/**
 * Structural validation: envelope schema, page ids, #page: link resolvability,
 * difit-ref block syntax. Does NOT check file existence or line bounds - that
 * requires repo/diff context (see ResolverContext).
 */
export function validatePlanStructure(input: unknown): PlanValidationResult {
  const errors: PlanValidationError[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail([{ code: 'ENVELOPE_INVALID', path: '$', message: 'plan must be a JSON object' }]);
  }
  const obj = input as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    errors.push({
      code: 'ENVELOPE_INVALID',
      path: '$.schemaVersion',
      message: `schemaVersion must be 1, got ${JSON.stringify(obj.schemaVersion)}`,
    });
  }
  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    errors.push({ code: 'ENVELOPE_INVALID', path: '$.title', message: 'title must be a non-empty string' });
  }
  if (!Array.isArray(obj.pages) || obj.pages.length === 0) {
    errors.push({ code: 'ENVELOPE_INVALID', path: '$.pages', message: 'pages must be a non-empty array' });
    return fail(errors);
  }

  const allowedEnvelopeKeys = new Set(['schemaVersion', 'title', 'pages']);
  for (const key of Object.keys(obj)) {
    if (!allowedEnvelopeKeys.has(key)) {
      errors.push({ code: 'ENVELOPE_INVALID', path: `$.${key}`, message: `unknown envelope key "${key}"` });
    }
  }

  const ids = new Set<string>();
  const pages: { id: string; body: string }[] = [];

  (obj.pages as unknown[]).forEach((p, i) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      errors.push({ code: 'ENVELOPE_INVALID', path: `$.pages[${i}]`, message: 'page must be an object' });
      return;
    }
    const page = p as Record<string, unknown>;
    const allowedPageKeys = new Set(['id', 'title', 'body']);
    for (const key of Object.keys(page)) {
      if (!allowedPageKeys.has(key)) {
        errors.push({
          code: 'ENVELOPE_INVALID',
          path: `$.pages[${i}].${key}`,
          message: `unknown page key "${key}"`,
        });
      }
    }
    const id = page.id;
    if (typeof id !== 'string' || !PAGE_ID_RE.test(id) || id.length > PAGE_ID_MAX) {
      errors.push({
        code: 'PAGE_ID_INVALID',
        path: `$.pages[${i}].id`,
        message: `page id must match ${PAGE_ID_RE} and be at most ${PAGE_ID_MAX} chars, got ${JSON.stringify(id)}`,
      });
    } else if (ids.has(id)) {
      errors.push({ code: 'PAGE_ID_DUPLICATE', path: `$.pages[${i}].id`, message: `duplicate page id "${id}"` });
    } else {
      ids.add(id);
    }
    if (typeof page.title !== 'string' || page.title.trim() === '') {
      errors.push({
        code: 'ENVELOPE_INVALID',
        path: `$.pages[${i}].title`,
        message: 'page title must be a non-empty string',
      });
    }
    if (typeof page.body !== 'string') {
      errors.push({ code: 'ENVELOPE_INVALID', path: `$.pages[${i}].body`, message: 'page body must be a string' });
      return;
    }
    pages.push({ id: typeof id === 'string' ? id : `#${i}`, body: page.body });
  });

  // #page: links + difit-ref syntax
  for (const page of pages) {
    for (const target of extractPageLinks(page.body)) {
      if (!ids.has(target)) {
        errors.push({
          code: 'PAGE_LINK_UNRESOLVED',
          path: `$.pages[${page.id}].body`,
          message: `link "#page:${target}" does not resolve to any page id`,
        });
      }
    }
    extractRefBlocks(page.body).forEach((raw, i) => {
      const parsed = parseRefBlock(raw, `pages[${page.id}].refs[${i}]`);
      errors.push(...parsed.errors);
    });
  }

  return errors.length > 0 ? fail(errors) : { ok: true, errors: [] };
}

/**
 * Context the caller supplies to check refs against a real diff/repository.
 * The wrapper implements this on top of the fork's git machinery.
 */
export interface ResolverContext {
  /**
   * Returns the total line count of the referenced file on the relevant
   * revision (head for side=new / unchanged files, base for side=old),
   * or null when the file does not exist there.
   */
  getLineCount(ref: DifitRef): Promise<number | null> | number | null;
}

/** Second-stage validation: file existence and line bounds for every ref. */
export async function validatePlanRefs(
  plan: WalkthroughPlan,
  ctx: ResolverContext
): Promise<PlanValidationResult> {
  const errors: PlanValidationError[] = [];
  for (const page of plan.pages) {
    const blocks = extractRefBlocks(page.body);
    for (let i = 0; i < blocks.length; i++) {
      const path = `pages[${page.id}].refs[${i}]`;
      const parsed = parseRefBlock(blocks[i] ?? '', path);
      if (!parsed.ref) {
        errors.push(...parsed.errors);
        continue;
      }
      const lineCount = await ctx.getLineCount(parsed.ref);
      if (lineCount === null) {
        errors.push({
          code: 'REF_FILE_NOT_FOUND',
          path,
          message: `file "${parsed.ref.file}" not found on the ${parsed.ref.side ?? 'new'} side`,
        });
      } else if (parsed.ref.lines.end > lineCount) {
        errors.push({
          code: 'REF_LINES_OUT_OF_RANGE',
          path,
          message: `lines ${parsed.ref.lines.start}-${parsed.ref.lines.end} exceed file length ${lineCount} of "${parsed.ref.file}"`,
        });
      }
    }
  }
  return errors.length > 0 ? fail(errors) : { ok: true, errors: [] };
}

function fail(errors: PlanValidationError[]): PlanValidationResult {
  return { ok: false, errors };
}
