'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { authErrorMessage, postRecovery } from '../auth-client';
import { FormMessage } from '../form-message';

const FIELD_CLASS =
  'mt-1.5 min-h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-base text-[var(--ink)] focus-visible:border-[var(--thread)]';

const ACKNOWLEDGEMENT =
  'If an account exists for that address, a recovery request has been recorded. Email delivery is not enabled in this preview, so no message will arrive.';

export default function RecoveryPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    setStatus('');

    try {
      await postRecovery(email);
      // The server returns the same acknowledgement for known and unknown
      // addresses; this copy must not add an existence signal.
      setStatus(ACKNOWLEDGEMENT);
    } catch (error_) {
      setError(authErrorMessage(error_));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Recover access</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        Enter the email address for your account. For privacy, the response is
        the same whether or not an account exists.
      </p>

      <form className="mt-8" onSubmit={onSubmit} aria-describedby="recovery-form-note">
        <p id="recovery-form-note" className="sr-only">
          The email address is required.
        </p>

        <div>
          <label htmlFor="recovery-email" className="text-sm font-medium">
            Email address
          </label>
          <input
            id="recovery-email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            className={FIELD_CLASS}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-[var(--ink)] px-5 py-2.5 text-sm font-medium text-[var(--paper)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Sending request…' : 'Request recovery'}
        </button>
      </form>

      <FormMessage error={error} status={status} />

      <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-3 border-t border-[var(--line)] pt-5 text-sm" aria-label="Other account actions">
        <Link className="underline underline-offset-4" href="/login">
          Back to log in
        </Link>
        <Link className="underline underline-offset-4" href="/signup">
          Create an account
        </Link>
      </nav>
    </div>
  );
}
