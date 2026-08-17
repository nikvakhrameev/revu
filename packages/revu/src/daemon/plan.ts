import {
  collectRefs,
  validatePlanStructure,
  validatePlanRefs,
  type PlanValidationResult,
  type StaleRef,
  type WalkthroughPlan,
} from '@revu/plan-schema';

import { getBlobLineCount, hashSnippet } from './git.js';
import type { PlanFile } from './store.js';
import type { StaleReportEntry } from '../shared/protocol.js';

// Walkthrough plan machinery on the daemon side: full validation against the
// pinned task revisions, snippet hashing, staleness reports.

function shaForSide(side: 'old' | 'new' | undefined, baseSha: string, targetSha: string): string {
  return side === 'old' ? baseSha : targetSha;
}

export async function validatePlanFull(
  plan: unknown,
  repoRoot: string,
  baseSha: string,
  targetSha: string,
): Promise<PlanValidationResult> {
  const structural = validatePlanStructure(plan);
  if (!structural.ok) return structural;
  return validatePlanRefs(plan as WalkthroughPlan, {
    getLineCount: (ref) =>
      getBlobLineCount(repoRoot, shaForSide(ref.side, baseSha, targetSha), ref.file),
  });
}

export async function computePlanHashes(
  plan: WalkthroughPlan,
  repoRoot: string,
  baseSha: string,
  targetSha: string,
): Promise<PlanFile['hashes']> {
  const hashes: PlanFile['hashes'] = [];
  for (const loc of collectRefs(plan)) {
    const result = await hashSnippet(
      repoRoot,
      shaForSide(loc.ref.side, baseSha, targetSha),
      loc.ref.file,
      loc.ref.lines,
    );
    hashes.push({
      pageId: loc.pageId,
      refIndex: loc.refIndex,
      file: loc.ref.file,
      lines: loc.ref.lines,
      ...(loc.ref.side ? { side: loc.ref.side } : {}),
      hash: 'hash' in result ? result.hash : `missing:${result.missing}`,
    });
  }
  return hashes;
}

/**
 * Recompute stored snippet hashes against the current pinned revisions and
 * report every divergence. Machine-readable, meant for the agent to repair
 * the plan on its own.
 */
export async function computeStaleReport(
  planFile: PlanFile,
  repoRoot: string,
  baseSha: string,
  targetSha: string,
): Promise<StaleReportEntry[]> {
  const report: StaleReportEntry[] = [];
  for (const entry of planFile.hashes) {
    const result = await hashSnippet(
      repoRoot,
      shaForSide(entry.side, baseSha, targetSha),
      entry.file,
      entry.lines,
    );
    if ('missing' in result) {
      report.push({
        pageId: entry.pageId,
        refIndex: entry.refIndex,
        file: entry.file,
        lines: entry.lines,
        ...(entry.side ? { side: entry.side } : {}),
        reason: result.missing === 'file' ? 'file-missing' : 'lines-out-of-range',
      });
    } else if (result.hash !== entry.hash) {
      report.push({
        pageId: entry.pageId,
        refIndex: entry.refIndex,
        file: entry.file,
        lines: entry.lines,
        ...(entry.side ? { side: entry.side } : {}),
        reason: 'content-changed',
      });
    }
  }
  return report;
}

export function staleReportToRefs(report: StaleReportEntry[]): StaleRef[] {
  return report.map((e) => ({
    pageId: e.pageId,
    refIndex: e.refIndex,
    file: e.file,
    lines: e.lines,
    ...(e.side ? { side: e.side } : {}),
  }));
}
