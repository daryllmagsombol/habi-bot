'use client';

import { AppBar } from '../../../components/app-bar';
import { PanelSwitch } from '../../../components/panels';
import type { PanelId } from '../../../lib/links';
import type { WorkspaceData, WorkspaceThread } from './workspace-data';

export interface WorkspaceHeaderProps {
  readonly data: WorkspaceData;
  readonly thread: WorkspaceThread | undefined;
  readonly panel: PanelId | undefined;
  readonly conversationHref: string;
  readonly onSelectPanel: (panel: PanelId) => void;
}

/** The workspace bar; the panel switch exists only while a thread is open. */
export function WorkspaceHeader({
  data,
  thread,
  panel,
  conversationHref,
  onSelectPanel,
}: Readonly<WorkspaceHeaderProps>) {
  return (
    <AppBar
      section="bots"
      counts={data.counts}
      allowance={data.allowance}
      mode={data.mode}
      actions={
        thread === undefined ? undefined : (
          <PanelSwitch
            panel={panel}
            documentHref={thread.hrefs.document}
            contextHref={thread.hrefs.context}
            conversationHref={conversationHref}
            onSelect={onSelectPanel}
          />
        )
      }
    />
  );
}
