import type { ElementType, ReactNode } from 'react';

export type ToolbarTone = 'plain' | 'surface' | 'canvas';

const TONES: Record<ToolbarTone, string> = {
  plain: '',
  surface: 'bg-surface',
  canvas: 'bg-canvas',
};

export interface ToolbarProps {
  readonly as?: 'div' | 'header' | 'nav' | 'form' | 'section';
  readonly tone?: ToolbarTone;
  /** Adds the hairline that separates a bar from the content below it. */
  readonly bordered?: boolean;
  /** Keeps the bar attached while its pane scrolls. Give it a solid tone. */
  readonly sticky?: boolean;
  /** `between` pushes the trailing control group to the far edge. */
  readonly justify?: 'start' | 'between';
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A horizontal control strip: app bar contents, a conversation header, a panel
 * header. It owns alignment and the hairline, not its children's behaviour.
 *
 * Wrapping is the default because a toolbar that clips its last control on a
 * narrow screen is a lost action, not a layout detail.
 */
export function Toolbar({
  as = 'div',
  tone = 'plain',
  bordered = false,
  sticky = false,
  justify = 'start',
  className,
  children,
}: Readonly<ToolbarProps>) {
  const Tag = as as ElementType;
  const alignment = justify === 'between' ? 'justify-between' : 'justify-start';

  return (
    <Tag
      className={[
        'flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2',
        alignment,
        TONES[tone],
        bordered ? 'border-b border-line' : '',
        sticky ? 'sticky top-0 z-20' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </Tag>
  );
}
