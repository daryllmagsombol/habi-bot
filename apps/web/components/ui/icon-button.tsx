import type { ComponentProps, ReactNode } from 'react';

export type IconButtonVariant = 'ghost' | 'surface' | 'solid';

const BASE =
  'grid size-11 shrink-0 place-items-center rounded-sm transition-colors ' +
  'duration-[var(--habi-duration-fast)] ease-standard';

const VARIANTS: Record<IconButtonVariant, string> = {
  ghost: 'text-subtle hover:bg-sunken hover:text-ink disabled:cursor-not-allowed',
  surface:
    'border border-line bg-surface text-ink hover:bg-sunken disabled:cursor-not-allowed disabled:text-subtle',
  solid:
    'bg-ink text-ink-inverse hover:bg-accent hover:text-on-accent ' +
    'disabled:cursor-not-allowed disabled:bg-ink disabled:opacity-35',
};

export function iconButtonClass(variant: IconButtonVariant, className?: string): string {
  return [BASE, VARIANTS[variant], className].filter(Boolean).join(' ');
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'className' | 'children'> {
  /** Sets `aria-label`; icon-only controls always carry one. */
  readonly label: string;
  readonly icon: ReactNode;
  readonly variant?: IconButtonVariant;
  readonly className?: string;
}

/** A square icon control. The label is required, so an unlabelled icon is a type error. */
export function IconButton({
  label,
  icon,
  variant = 'ghost',
  className,
  type = 'button',
  ...rest
}: Readonly<IconButtonProps>) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={iconButtonClass(variant, className)}
    >
      {icon}
    </button>
  );
}
