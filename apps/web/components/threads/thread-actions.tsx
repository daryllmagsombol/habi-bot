'use client';

import type { ReactNode } from 'react';
import { Button } from '../ui';

export interface ThreadActionsProps {
  readonly onCreate: () => void;
  readonly onRename?: (() => void) | undefined;
  /** Shown instead of the controls when the API is not configured. */
  readonly disabledNote?: ReactNode;
  readonly disabled?: boolean;
}

/**
 * The thread-card controls: create always, rename only while a thread is open.
 * They sit in the card footer rather than inside the row links, so no control is
 * nested in a navigation target.
 */
export function ThreadActions({
  onCreate,
  onRename,
  disabledNote,
  disabled = false,
}: Readonly<ThreadActionsProps>) {
  if (disabled) {
    return (
      <p className="text-xs leading-relaxed text-subtle">
        {disabledNote ?? 'Creating and renaming threads needs the chat API.'}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={onCreate}>
        New thread
      </Button>
      {onRename === undefined ? null : (
        <Button variant="ghost" size="sm" onClick={onRename}>
          Rename
        </Button>
      )}
    </div>
  );
}
