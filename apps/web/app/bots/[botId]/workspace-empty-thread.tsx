'use client';

import { Button, EmptyState } from '../../../components/ui';

export interface WorkspaceEmptyThreadProps {
  readonly live: boolean;
}

/** A Bot with no conversation: instruction and memory still exist, a thread does not. */
export function WorkspaceEmptyThread({ live }: Readonly<WorkspaceEmptyThreadProps>) {
  return (
    <div className="order-1 min-w-0 lg:order-none">
      <EmptyState
        headingLevel={2}
        title="No threads yet"
        description={
          live
            ? 'This Bot has no conversation in your account. Creating a thread is not exposed by this API yet, so there is nothing to open here.'
            : 'A Bot with no threads still has its instructions and memory. Opening the first thread is part of the wired workspace.'
        }
        action={<Button disabled>New thread</Button>}
      />
    </div>
  );
}
