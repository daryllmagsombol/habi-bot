'use client';

interface FormMessageProps {
  error: string;
  status: string;
}

/**
 * Shared live region. `role="alert"` announces errors immediately; the status
 * line uses `role="status"` so success is announced without stealing focus.
 */
export function FormMessage({ error, status }: FormMessageProps) {
  return (
    <div className="mt-6 space-y-2" aria-live="polite">
      {error === '' ? null : (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </p>
      )}
      {status === '' ? null : (
        <p
          role="status"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {status}
        </p>
      )}
    </div>
  );
}
