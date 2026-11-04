import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { buttonStyles, type ButtonSize, type ButtonVariant } from './button';

export interface ButtonLinkProps extends ComponentProps<typeof Link> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly block?: boolean;
  readonly children?: ReactNode;
}

/** The same control as a real link, so navigation still works without script. */
export function ButtonLink({
  variant,
  size,
  block,
  className,
  children,
  ...rest
}: Readonly<ButtonLinkProps>) {
  return (
    <Link {...rest} className={buttonStyles({ variant, size, block, className })}>
      {children}
    </Link>
  );
}
