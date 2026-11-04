import type { ElementType, ReactNode } from 'react';

export type ContainerSize = 'form' | 'narrow' | 'reading' | 'default' | 'wide';

const SIZE: Record<ContainerSize, string> = {
  form: 'max-w-form',
  narrow: 'max-w-narrow',
  reading: 'max-w-reading',
  default: 'max-w-default',
  wide: 'max-w-wide',
};

export interface ContainerProps {
  readonly size?: ContainerSize;
  readonly as?: 'div' | 'section' | 'main' | 'header' | 'footer' | 'nav';
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * Page gutter and maximum measure.
 *
 * The gutter is fluid (`clamp(20px, 4.5vw, 48px)`), so 320px never feels
 * cramped and 1440px never stretches a line past a readable measure. Full-bleed
 * regions (the workspace panes) set their own width and use `Container` only
 * inside a pane.
 */
export function Container({ size = 'default', as = 'div', className, children }: Readonly<ContainerProps>) {
  const Tag = as as ElementType;

  return (
    <Tag className={['mx-auto w-full px-gutter', SIZE[size], className].filter(Boolean).join(' ')}>
      {children}
    </Tag>
  );
}
