'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { authErrorMessage, postAuth } from '../auth-client';
import { FormMessage } from '../form-message';

const FIELD_CLASS =
  'mt-1.5 min-h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-base text-[var(--ink)] focus-visible:border-[var(--thread)]';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError('');
    setStatus('');

    try {
      const result = await postAuth('signup', { email, password, inviteToken });
      setStatus(`Account created for ${result.user.email}. You are signed in.`);
      setPassword('');
      setInviteToken('');
    } catch (error_) {
      setError(authErrorMessage(error_));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">Create an account</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        Registration is invite-only. Your invitation must match this email
        address and has not been used before.
      </p>

      <form className="mt-8" onSubmit={onSubmit} aria-describedby="signup-form-note">
        <p id="signup-form-note" className="sr-only">
          All fields are required. Passwords must be at least 12 characters.
        </p>

        <div>
          <label htmlFor="signup-email" className="text-sm font-medium">
            Email address
          </label>
          <input
            id="signup-email"
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
          <label htmlFor="signup-password" className="text-sm font-medium">
            Password
          </label>
          <input
            id="signup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            aria-describedby="signup-password-hint"
            className={FIELD_CLASS}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p id="signup-password-hint" className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">
            At least 12 characters. Do not use your email address as the password.
          </p>
        </div>

        <div className="mt-5">
          <label htmlFor="signup-invite" className="text-sm font-medium">
            Invitation token
          </label>
          <input
            id="signup-invite"
            name="inviteToken"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby="signup-invite-hint"
            className={`${FIELD_CLASS} font-mono text-sm`}
            value={inviteToken}
            onChange={(event) => setInviteToken(event.target.value)}
          />
          <p id="signup-invite-hint" className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">
            Invitations are issued out of band. Ask the Habi maintainer if you
            need one.
          </p>
        </div>

        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-[var(--ink)] px-5 py-2.5 text-sm font-medium text-[var(--paper)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <FormMessage error={error} status={status} />

      <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-3 border-t border-[var(--line)] pt-5 text-sm" aria-label="Other account actions">
        <Link className="underline underline-offset-4" href="/login">
          Log in instead
        </Link>
        <Link className="underline underline-offset-4" href="/recovery">
          Recover access
        </Link>
      </nav>
    </div>
  );
}
