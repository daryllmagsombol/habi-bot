'use client';

import { Button, EmptyState } from '../../../components/ui';

export interface WorkspaceEmptyThreadProps {
  readonly live: boolean;
  readonly onCreateThread?: (() => void) | undefined;
}

/** A Bot with no conversation: instruction and memory still exist, a thread does not. */
export function WorkspaceEmptyThread({
  live,
  onCreateThread,
}: Readonly<WorkspaceEmptyThreadProps>) {
  return (
    <div className="order-1 min-w-0 lg:order-none">
      <EmptyState
        headingLevel={2}
        title="No threads yet"
        description={
          live
            ? 'This Bot has no conversation in your account. Create the first thread to start its history.'
            : 'A Bot with no threads still has its instructions and memory. Opening the first thread is part of the wired workspace.'
        }
        action={
          live ? (
            <Button onClick={onCreateThread}>New thread</Button>
          ) : (
            <Button disabled>New thread</Button>
          )
        }
      />
    </div>
  );
}
