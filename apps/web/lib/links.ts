export type PanelId = 'document' | 'context';

/**
 * The thread and panel live in the URL, so every view is linkable, reloadable,
 * and reachable with the browser's back button. Choosing the panel that is
 * already open returns the conversation, which is what makes the top-right
 * control a toggle rather than two separate buttons.
 */
export function threadHref(botId: string, threadId: string, panel?: PanelId): string {
  const params = new URLSearchParams({ thread: threadId });

  if (panel !== undefined) {
    params.set('panel', panel);
  }

  return `/bots/${botId}?${params.toString()}`;
}

export function botHref(botId: string): string {
  return `/bots/${botId}`;
}

export function readParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function readPanel(value: string | undefined): PanelId | undefined {
  return value === 'document' || value === 'context' ? value : undefined;
}
