import { AlertIcon, CheckIcon } from './icons';

export type FormMessageTone = 'error' | 'success' | 'info';

export interface FormMessageProps {
  /** Announced assertively (`role="alert"`). Takes precedence visually. */
  readonly error?: string;
  /** Announced politely through the native `<output>` element. */
  readonly status?: string;
  /** Neutral guidance, e.g. a bounded limitation. Not an error. */
  readonly info?: string;
  readonly className?: string;
}

const TONE: Record<FormMessageTone, string> = {
  error: 'border-danger-line bg-danger-soft text-danger-ink',
  success: 'border-success-line bg-success-soft text-success',
  info: 'border-accent-line bg-accent-soft text-ink',
};

function ToneIcon({ tone }: Readonly<{ tone: FormMessageTone }>) {
  if (tone === 'success') {
    return <CheckIcon size={14} />;
  }

  if (tone === 'error') {
    return <AlertIcon size={14} />;
  }

  return null;
}

/**
 * The page's single live region.
 *
 * The wrapper always renders with `aria-live="polite"` so the region exists
 * before content arrives; inserting a live region at the same moment as its
 * message is unreliable in several screen readers. Errors additionally carry
 * `role="alert"` for immediate announcement. Nothing here steals focus, and no
 * border is used as the only signal: a tinted field, an icon, and the word
 * itself all carry the state.
 */
export function FormMessage({ error, status, info, className }: Readonly<FormMessageProps>) {
  const hasContent =
    (error !== undefined && error !== '') ||
    (status !== undefined && status !== '') ||
    (info !== undefined && info !== '');

  return (
    <div
      aria-live="polite"
      className={['space-y-2', hasContent ? 'mt-6' : '', className].filter(Boolean).join(' ')}
    >
      {error === undefined || error === '' ? null : (
        <p
          role="alert"
          className={`${TONE.error} flex items-start gap-2 rounded-sm border px-3.5 py-2.5 text-sm leading-relaxed`}
        >
          <span className="mt-1 shrink-0" aria-hidden="true">
            <ToneIcon tone="error" />
          </span>
          {error}
        </p>
      )}

      {status === undefined || status === '' ? null : (
        <output
          className={`${TONE.success} flex items-start gap-2 rounded-sm border px-3.5 py-2.5 text-sm leading-relaxed`}
        >
          <span className="mt-1 shrink-0" aria-hidden="true">
            <ToneIcon tone="success" />
          </span>
          {status}
        </output>
      )}

      {info === undefined || info === '' ? null : (
        <p
          className={`${TONE.info} flex items-start gap-2 rounded-sm border px-3.5 py-2.5 text-sm leading-relaxed`}
        >
          <span className="mt-1 shrink-0" aria-hidden="true">
            <ToneIcon tone="info" />
          </span>
          {info}
        </p>
      )}
    </div>
  );
}
