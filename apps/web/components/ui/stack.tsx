import type { ElementType, ReactNode } from 'react';

export type StackGap = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 12 | 'gutter' | 'section';
export type StackAlign = 'start' | 'center' | 'end' | 'stretch';
export type StackJustify = 'start' | 'center' | 'between' | 'end';

/*
 * Literal class strings (not template interpolation) so Tailwind's source
 * scanner can see them. A dynamic `gap-${n}` would be invisible to the compiler.
 */
const GAP: Record<StackGap, string> = {
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  5: 'gap-5',
  6: 'gap-6',
  7: 'gap-7',
  8: 'gap-8',
  9: 'gap-9',
  10: 'gap-10',
  12: 'gap-12',
  gutter: 'gap-gutter',
  section: 'gap-section',
};

const ALIGN: Record<StackAlign, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
};

const JUSTIFY: Record<StackJustify, string> = {
  start: 'justify-start',
  center: 'justify-center',
  between: 'justify-between',
  end: 'justify-end',
};

export interface StackProps {
  readonly as?: 'div' | 'section' | 'article' | 'header' | 'footer' | 'form' | 'ul' | 'ol' | 'li';
  readonly gap?: StackGap;
  readonly direction?: 'column' | 'row';
  readonly wrap?: boolean;
  readonly align?: StackAlign;
  readonly justify?: StackJustify;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** Vertical rhythm primitive. Vertical first; rows are the exception. */
export function Stack({
  as = 'div',
  gap = 4,
  direction = 'column',
  wrap = false,
  align,
  justify,
  className,
  children,
}: Readonly<StackProps>) {
  const Tag = as as ElementType;

  return (
    <Tag
      className={[
        'flex',
        direction === 'column' ? 'flex-col' : 'flex-row',
        wrap ? 'flex-wrap' : '',
        GAP[gap],
        align === undefined ? '' : ALIGN[align],
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
