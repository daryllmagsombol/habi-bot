'use client';

import { useEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { ArrowUpIcon, IconButton } from '../ui';

const COUNT = new Intl.NumberFormat('en-US');

export type ComposerStatus =
  | { readonly kind: 'ready' }
  | { readonly kind: 'disabled'; readonly message?: string }
  | { readonly kind: 'offline'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export interface ComposerProps {
  /** Id for the textarea; the label and live region derive from it. */
  readonly id: string;
  /** Accessible label, e.g. "Write a message to Field Notes". */
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onSend: () => void;
  readonly placeholder?: string;
  /** Guidance shown left of the counter when the composer is ready. */
  readonly hint?: ReactNode;
  readonly counter?: { readonly current: number; readonly max: number };
  readonly maxLength?: number;
  readonly status?: ComposerStatus | undefined;
  /** A leading control, typically an attach button. */
  readonly attachment?: ReactNode;
  readonly sendLabel?: string;
  readonly className?: string;
}

/**
 * The message field: multiline, growing, send-on-Enter, with a counter and one
 * live line for guidance or state.
 *
 * Fully controlled: the caller owns the draft and decides what sending means.
 * `status` is a typed union, so offline and error states cannot be expressed by
 * a stray boolean, and the live line is where their message appears.
 */
export function Composer({
  id,
  label,
  value,
  onValueChange,
  onSend,
  placeholder = 'Write a message…',
  hint,
  counter,
  maxLength = 4_000,
  status = { kind: 'ready' },
  attachment,
  sendLabel = 'Send message',
  className,
}: Readonly<ComposerProps>) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const canSend = status.kind === 'ready' && value.trim() !== '';
  const fieldDisabled = status.kind === 'disabled';
  const message = status.kind === 'ready' ? hint : (status.message ?? hint);
  const statusId = `${id}-status`;

  useEffect(() => {
    const field = fieldRef.current;

    if (field === null) {
      return;
    }

    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [value]);

  function submit() {
    if (!canSend) {
      return;
    }

    onSend();
    window.requestAnimationFrame(() => fieldRef.current?.focus());
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && canSend) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className={className}
      onSubmit={onSubmit}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>

      <div className="flex items-end gap-1 rounded-lg border border-line bg-canvas/70 py-1 pr-1 pl-2 transition-[border-color,box-shadow] duration-[var(--habi-duration-fast)] ease-standard focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/15">
        {attachment}

        <textarea
          ref={fieldRef}
          id={id}
          name="message"
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-describedby={statusId}
          disabled={fieldDisabled}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-40 min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent py-2.5 text-base leading-normal text-ink placeholder:text-subtle focus:outline-none disabled:cursor-not-allowed"
        />

        <IconButton
          type="submit"
          variant="solid"
          label={sendLabel}
          disabled={!canSend}
          icon={<ArrowUpIcon size={16} />}
        />
      </div>

      <div className="mt-1.5 flex min-h-4 justify-between gap-2 text-2xs text-subtle">
        <p
          id={statusId}
          role={status.kind === 'error' ? 'alert' : 'status'}
          aria-live={status.kind === 'error' ? 'assertive' : 'polite'}
        >
          {message}
        </p>
        {counter === undefined ? null : (
          <span aria-hidden="true" className="u-figures shrink-0 text-subtle">
            {COUNT.format(counter.current)} / {COUNT.format(counter.max)}
          </span>
        )}
      </div>
    </form>
  );
}
