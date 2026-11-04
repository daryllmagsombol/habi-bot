'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { Button, FormMessage, TextField } from '../../../components/ui';
import { authErrorMessage, postRecovery } from '../auth-client';

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
    <div>
      <h1 className="text-page tracking-heading text-ink">Recover access</h1>
      <p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-muted">
        Enter the email address for your account. For privacy, the response is
        the same whether or not an account exists.
      </p>

      <form className="mt-8" onSubmit={onSubmit} aria-describedby="recovery-form-note">
        <p id="recovery-form-note" className="sr-only">
          The email address is required.
        </p>

        <TextField
          id="recovery-email"
          name="email"
          type="email"
          label="Email address"
          autoComplete="username"
          inputMode="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <Button type="submit" block loading={pending} className="mt-6">
          {pending ? 'Sending request…' : 'Request recovery'}
        </Button>
      </form>

      <FormMessage error={error} status={status} />

      <nav
        className="mt-8 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-4 text-sm"
        aria-label="Other account actions"
      >
        <Link className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline" href="/login">
          Back to log in
        </Link>
        <Link className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline" href="/signup">
          Create an account
        </Link>
      </nav>
    </div>
  );
}
