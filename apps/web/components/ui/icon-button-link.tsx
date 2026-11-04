import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { iconButtonClass, type IconButtonVariant } from './icon-button';

export interface IconButtonLinkProps
  extends Omit<ComponentProps<typeof Link>, 'className' | 'children'> {
  readonly label: string;
  readonly icon: ReactNode;
  readonly variant?: IconButtonVariant;
  readonly className?: string;
}

/** The same control as a real link, so navigation still works without script. */
export function IconButtonLink({
  label,
  icon,
  variant = 'ghost',
  className,
  ...rest
}: Readonly<IconButtonLinkProps>) {
  return (
    <Link {...rest} aria-label={label} className={iconButtonClass(variant, className)}>
      {icon}
    </Link>
  );
}
