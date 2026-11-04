import type { ElementType, ReactNode } from 'react';
import {
  ALIGN,
  GAP,
  JUSTIFY,
  type StackAlign,
  type StackGap,
  type StackJustify,
} from './stack';

export interface InlineProps {
  readonly as?: 'div' | 'nav' | 'ul' | 'li' | 'p' | 'span' | 'header' | 'footer';
  readonly gap?: StackGap;
  readonly wrap?: boolean;
  readonly align?: StackAlign;
  readonly justify?: StackJustify;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** Horizontal, wrapping group: action rows, link lists, metadata strips. */
export function Inline({
  as = 'div',
  gap = 3,
  wrap = true,
  align = 'center',
  justify,
  className,
  children,
}: Readonly<InlineProps>) {
  const Tag = as as ElementType;

  return (
    <Tag
      className={[
        'flex flex-row',
        wrap ? 'flex-wrap' : '',
        GAP[gap],
        ALIGN[align],
        justify === undefined ? '' : JUSTIFY[justify],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </Tag>
  );
}
