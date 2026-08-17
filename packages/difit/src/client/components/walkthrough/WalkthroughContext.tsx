import { createContext, useContext } from 'react';

import type { StaleRef } from '@revu/plan-schema';

import type {
  CommentThread,
  DiffFile,
  DiffSide,
  DiffViewMode,
  LineNumber,
} from '../../../types/diff';
import type { AppearanceSettings } from '../SettingsModal';

/**
 * Everything a plan page / snippet needs from the app: the loaded diff, the
 * comment handlers (same ones the full diff uses, so threads created in the
 * plan land in the shared store) and plan-level callbacks.
 */
export interface WalkthroughContextValue {
  files: DiffFile[];
  diffMode: DiffViewMode;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  baseCommitish?: string;
  targetCommitish?: string;
  threadsByFile: Map<string, CommentThread[]>;
  showAuthorBadges: boolean;
  staleRefs: StaleRef[];
  onAddComment: (
    file: string,
    line: LineNumber,
    body: string,
    codeContent?: string,
    side?: DiffSide,
  ) => Promise<void>;
  onGenerateThreadPrompt: (thread: CommentThread) => string;
  onRemoveThread: (threadId: string) => void;
  onReplyToThread: (threadId: string, body: string) => Promise<void>;
  onRemoveMessage: (threadId: string, messageId: string) => void;
  onUpdateMessage: (threadId: string, messageId: string, newBody: string) => void;
  onOpenInEditor?: ((filePath: string, lineNumber: number) => void) | undefined;
  onOpenInFullDiff: (filePath: string, side: DiffSide, line: number) => void;
}

const WalkthroughContext = createContext<WalkthroughContextValue | null>(null);

export const WalkthroughProvider = WalkthroughContext.Provider;

export function useWalkthroughContext(): WalkthroughContextValue {
  const value = useContext(WalkthroughContext);
  if (!value) {
    throw new Error('useWalkthroughContext must be used inside a WalkthroughProvider');
  }
  return value;
}
