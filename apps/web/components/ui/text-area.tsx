import type { ComponentProps, ReactNode } from 'react';

export interface TextAreaProps
  extends Omit<ComponentProps<'textarea'>, 'id' | 'className' | 'rows'> {
  /** Required: the label and hint/error ids are derived from it. */
  readonly id: string;
  readonly label: string;
  readonly rows?: number;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly className?: string;
  readonly inputClassName?: string;
}

/**
 * A labelled multiline control, matching `TextField`'s anatomy: label, control,
 * hint, error. Used by forms that receive untrusted text (Bot instructions,
 * memory proposals, artifact bodies) and never render it as HTML.
 */
export function TextArea({
  id,
  label,
  rows = 5,
  hint,
  error,
  className,
  inputClassName,
  required,
  'aria-describedby': describedByProp,
  ...rest
}: Readonly<TextAreaProps>) {
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

      <textarea
        {...rest}
        id={id}
        rows={rows}
        required={required}
        aria-describedby={describedBy}
        aria-invalid={error === undefined ? undefined : true}
        className={[
          'min-h-11 w-full resize-y rounded-sm border bg-surface px-3 py-2.5 text-base leading-normal text-ink',
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
