import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const TRANSITION =
  'transition-[background-color,border-color,color] duration-[var(--habi-duration-fast)] ease-standard';

/* Disabled is a state, not a faded copy of the label: an unavailable control
 * keeps its shape and drops to the neutral surface, so it still reads as a
 * control the reader cannot use yet. */
const DISABLED =
  'disabled:border-line disabled:bg-surface disabled:text-subtle disabled:shadow-none ' +
  'disabled:hover:bg-surface disabled:hover:text-subtle disabled:hover:border-line';

const VARIANTS: Record<ButtonVariant, string> = {
  /* The one filled control on a screen: ink on paper, iris when hovered. */
  primary:
    'bg-ink text-ink-inverse shadow-card hover:bg-accent hover:text-on-accent motion-safe:active:translate-y-px',
  secondary:
    'border border-line bg-surface text-ink hover:border-line-strong hover:bg-sunken motion-safe:active:translate-y-px',
  /* Text action: the underline is the affordance, so it is always present. */
  ghost:
    'text-ink underline decoration-line-strong decoration-1 underline-offset-4 hover:no-underline',
  danger: 'bg-danger text-on-danger hover:bg-danger-hover motion-safe:active:translate-y-px',
};

/* Every size clears the 44px touch target. `sm` changes padding and type size
 * only, so a compact control never shrinks below a comfortable target. */
const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-11 text-xs',
  md: 'min-h-11 text-sm',
  lg: 'min-h-12 text-sm',
};

const SIZE_PADDING: Record<ButtonSize, string> = {
  sm: 'px-3',
  md: 'px-4',
  lg: 'px-5',
};

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-sm text-center font-medium ' +
  'disabled:cursor-not-allowed aria-busy:cursor-progress';

export interface ButtonStyleOptions {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
  readonly block?: boolean | undefined;
  readonly className?: string | undefined;
}

/** Shared class builder, so a link and a button can look identical. */
export function buttonStyles({
  variant = 'primary',
  size = 'md',
  block = false,
  className,
}: Readonly<ButtonStyleOptions> = {}): string {
  /* A ghost action aligns its text with neighbouring labels: no side padding. */
  const padding = variant === 'ghost' ? 'px-0' : SIZE_PADDING[size];

  return [
    BASE,
    TRANSITION,
    VARIANTS[variant],
    variant === 'ghost' ? 'disabled:no-underline' : DISABLED,
    SIZES[size],
    padding,
    block ? 'w-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ComponentProps<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly block?: boolean;
  /** Sets `aria-busy`, disables the control, and shows the loader. */
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

export function Button({
  variant,
  size,
  block,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: Readonly<ButtonProps>) {
  return (
    <button
      {...rest}
      type={type}
      className={buttonStyles({ variant, size, block, className })}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
