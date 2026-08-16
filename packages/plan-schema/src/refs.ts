import yaml from 'js-yaml';

import type { DifitRef, PlanValidationError, WalkthroughPlan, RefLocation } from './types.js';

const REF_FENCE_RE = /^```difit-ref[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const PAGE_LINK_RE = /\]\(#page:([^)\s]+)\)/g;
const LINES_RE = /^(\d+)(?:-(\d+))?$/;

const ALLOWED_KEYS = new Set(['file', 'lines', 'side']);

export interface ParsedRefBlock {
  /** null when the block failed to parse; errors describe why. */
  ref: DifitRef | null;
  errors: PlanValidationError[];
}

/** Extract raw ```difit-ref block bodies from a markdown page body, in order. */
export function extractRefBlocks(body: string): string[] {
  const blocks: string[] = [];
  for (const m of body.matchAll(REF_FENCE_RE)) {
    blocks.push(m[1] ?? '');
  }
  return blocks;
}

/** Extract #page: link targets from a markdown page body. */
export function extractPageLinks(body: string): string[] {
  const targets: string[] = [];
  for (const m of body.matchAll(PAGE_LINK_RE)) {
    if (m[1]) targets.push(m[1]);
  }
  return targets;
}

export function parseRefBlock(raw: string, path: string): ParsedRefBlock {
  const errors: PlanValidationError[] = [];
  let doc: unknown;
  try {
    doc = yaml.load(raw, { schema: yaml.FAILSAFE_SCHEMA });
  } catch (e) {
    return {
      ref: null,
      errors: [
        {
          code: 'REF_YAML_INVALID',
          path,
          message: `difit-ref body is not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      ref: null,
      errors: [{ code: 'REF_YAML_INVALID', path, message: 'difit-ref body must be a YAML mapping' }],
    };
  }
  const obj = doc as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push({
        code: 'REF_KEY_UNKNOWN',
        path,
        message: `unknown key "${key}" in difit-ref (allowed: file, lines, side)`,
      });
    }
  }

  const file = obj.file;
  if (typeof file !== 'string' || file.trim() === '') {
    errors.push({ code: 'REF_FIELD_INVALID', path, message: '"file" is required and must be a non-empty string' });
  }

  const linesRaw = obj.lines;
  let lines: { start: number; end: number } | null = null;
  if (typeof linesRaw !== 'string' && typeof linesRaw !== 'number') {
    errors.push({
      code: 'REF_FIELD_INVALID',
      path,
      message: '"lines" is required and must be "N" or "N-M"',
    });
  } else {
    const m = LINES_RE.exec(String(linesRaw).trim());
    if (!m || !m[1]) {
      errors.push({
        code: 'REF_FIELD_INVALID',
        path,
        message: `"lines" must be "N" or "N-M", got "${String(linesRaw)}"`,
      });
    } else {
      const start = Number.parseInt(m[1], 10);
      const end = m[2] ? Number.parseInt(m[2], 10) : start;
      if (start < 1 || end < start) {
        errors.push({
          code: 'REF_FIELD_INVALID',
          path,
          message: `"lines" range is invalid: start must be >= 1 and end >= start (got ${start}-${end})`,
        });
      } else {
        lines = { start, end };
      }
    }
  }

  const sideRaw = obj.side;
  let side: 'old' | 'new' | undefined;
  if (sideRaw !== undefined) {
    if (sideRaw !== 'old' && sideRaw !== 'new') {
      errors.push({
        code: 'REF_FIELD_INVALID',
        path,
        message: `"side" must be "old" or "new", got "${String(sideRaw)}"`,
      });
    } else {
      side = sideRaw;
    }
  }

  if (errors.length > 0 || typeof file !== 'string' || lines === null) {
    return { ref: null, errors };
  }
  return { ref: { file: file.trim(), lines, ...(side ? { side } : {}) }, errors: [] };
}

/** Collect all successfully parsed refs of a plan with their locations. Invalid blocks are skipped. */
export function collectRefs(plan: WalkthroughPlan): RefLocation[] {
  const out: RefLocation[] = [];
  for (const page of plan.pages) {
    const blocks = extractRefBlocks(page.body);
    blocks.forEach((raw, i) => {
      const parsed = parseRefBlock(raw, `pages[${page.id}].refs[${i}]`);
      if (parsed.ref) {
        out.push({ pageId: page.id, refIndex: i, ref: parsed.ref });
      }
    });
  }
  return out;
}
