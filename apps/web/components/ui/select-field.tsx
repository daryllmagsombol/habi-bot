import type { ComponentProps, ReactNode } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps
  extends Omit<ComponentProps<'select'>, 'id' | 'className' | 'children'> {
  /** Required: the label and hint/error ids are derived from it. */
  readonly id: string;
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly className?: string;
  readonly inputClassName?: string;
}

/**
 * A labelled native select.
 *
 * Native is deliberate: the browser owns the popup, keyboard interaction and
 * announcement, so a small closed set of options stays accessible without a
 * custom listbox. The anatomy matches `TextField`: label, control, hint, error.
 */
export function SelectField({
  id,
  label,
  options,
  hint,
  error,
  className,
  inputClassName,
  'aria-describedby': describedByProp,
  ...rest
}: Readonly<SelectFieldProps>) {
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

      <select
        {...rest}
        id={id}
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
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

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
