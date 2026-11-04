import type { ComponentProps, ReactNode } from 'react';

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'id' | 'className' | 'size'> {
  /** Required: label/input pairing and hint/error ids are derived from it. */
  readonly id: string;
  readonly label: string;
  /** Static guidance. Rendered in the hint slot and wired with `aria-describedby`. */
  readonly hint?: ReactNode;
  /** Validation message. Also sets `aria-invalid` and swaps the border to danger. */
  readonly error?: string;
  readonly className?: string;
  readonly inputClassName?: string;
}

/**
 * A labelled text control.
 *
 * Anatomy: label → control → hint → error. The hint stays visible when an error
 * appears, because losing the guidance at the moment it is needed most is a
 * regression. Errors are described by `aria-describedby`; the page's shared
 * `FormMessage` live region owns announcement, so this element never
 * double-speaks.
 */
export function TextField({
  id,
  label,
  hint,
  error,
  className,
  inputClassName,
  required,
  'aria-describedby': describedByProp,
  ...rest
}: Readonly<TextFieldProps>) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [describedByProp, hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ') || undefined;

  return (
    <div className={['flex flex-col gap-2', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>

      <input
        {...rest}
        id={id}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={error === undefined ? undefined : true}
        className={[
          'min-h-11 w-full rounded-sm border bg-surface px-3 py-2.5 text-base text-ink',
          'transition-[border-color,background-color] duration-[var(--habi-duration-fast)] ease-standard',
          'focus-visible:outline-offset-1',
          'disabled:cursor-not-allowed disabled:bg-sunken disabled:text-subtle',
          error === undefined
            ? 'border-line-strong focus-visible:border-accent'
            : 'border-danger focus-visible:border-danger',
          inputClassName,
        ]
          .filter(Boolean)
          .join(' ')}
      />

      {hint === undefined ? null : (
        <p id={hintId} className="text-xs leading-relaxed text-muted">
          {hint}
        </p>
      )}

      {error === undefined ? null : (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
