'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { authErrorMessage, postAuth } from '../auth-client';
import { FormMessage } from '../form-message';

const FIELD_CLASS =
  'mt-1.5 min-h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-base text-[var(--ink)] focus-visible:border-[var(--thread)]';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    setStatus('');

    try {
      const result = await postAuth('login', { email, password });
      setStatus(`Signed in as ${result.user.email}.`);
      setPassword('');
    } catch (error_) {
      setError(authErrorMessage(error_));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Log in</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        Use the email address and password for your Habi account.
      </p>

      <form className="mt-8" onSubmit={onSubmit} aria-describedby="login-form-note">
        <p id="login-form-note" className="sr-only">
          All fields are required.
        </p>

        <div>
          <label htmlFor="login-email" className="text-sm font-medium">
            Email address
          </label>
          <input
            id="login-email"
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

        <div className="mt-5">
          <label htmlFor="login-password" className="text-sm font-medium">
            Password
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={FIELD_CLASS}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-[var(--ink)] px-5 py-2.5 text-sm font-medium text-[var(--paper)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <FormMessage error={error} status={status} />

      <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-3 border-t border-[var(--line)] pt-5 text-sm" aria-label="Other account actions">
        <Link className="underline underline-offset-4" href="/signup">
          Create an account
        </Link>
        <Link className="underline underline-offset-4" href="/recovery">
          Recover access
        </Link>
      </nav>
    </div>
  );
}
