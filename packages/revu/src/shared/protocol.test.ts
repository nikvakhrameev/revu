import { describe, expect, it } from 'vitest';

import { ERROR_EXIT_CODES, revuError } from './protocol.js';

describe('ERROR_EXIT_CODES', () => {
  it('maps CURSOR_INVALID to exit code 13', () => {
    expect(ERROR_EXIT_CODES.CURSOR_INVALID).toBe(13);
  });

  it('keeps error exit codes collision-free (success aliases aside)', () => {
    const failing = Object.values(ERROR_EXIT_CODES).filter((code) => code !== 0);
    expect(new Set(failing).size).toBe(failing.length);
  });
});

describe('revuError', () => {
  it('carries the CURSOR_INVALID details the agent needs for recovery', () => {
    expect(revuError('CURSOR_INVALID', 'cursor ahead', { since: 9, generation: 2 })).toEqual({
      error: {
        code: 'CURSOR_INVALID',
        message: 'cursor ahead',
        details: { since: 9, generation: 2 },
      },
    });
  });

  it('omits details when none are given', () => {
    expect(revuError('CURSOR_INVALID', 'cursor ahead')).toEqual({
      error: { code: 'CURSOR_INVALID', message: 'cursor ahead' },
    });
  });
});
