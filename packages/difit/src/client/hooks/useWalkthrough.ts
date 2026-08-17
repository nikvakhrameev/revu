import { useCallback, useEffect, useState } from 'react';

import type { WalkthroughPayload } from '@revu/plan-schema';

interface UseWalkthroughResult {
  payload: WalkthroughPayload | null;
  refetch: () => Promise<void>;
}

/**
 * Fetches the walkthrough plan for the current diff session from a managed
 * difit instance. Only active when the server reports managed mode; `refetch`
 * is wired to the `walkthroughChanged` SSE event.
 */
export function useWalkthrough(
  enabled: boolean,
  sessionQueryString: string | null,
): UseWalkthroughResult {
  const [payload, setPayload] = useState<WalkthroughPayload | null>(null);

  const refetch = useCallback(async () => {
    if (!enabled || !sessionQueryString) {
      return;
    }
    try {
      const response = await fetch(`/api/walkthrough?${sessionQueryString}`);
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as { payload?: WalkthroughPayload | null };
      setPayload(data.payload ?? null);
    } catch (error) {
      console.error('Failed to fetch walkthrough plan:', error);
    }
  }, [enabled, sessionQueryString]);

  useEffect(() => {
    if (!enabled || !sessionQueryString) {
      setPayload(null);
      return;
    }
    void refetch();
  }, [enabled, sessionQueryString, refetch]);

  return { payload, refetch };
}
