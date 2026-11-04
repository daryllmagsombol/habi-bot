'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { Button, FormMessage, Stack, TextField } from '../../../components/ui';
import { authErrorMessage, postAuth } from '../auth-client';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
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
    <div>
      <h1 className="text-page tracking-heading text-ink">Create an account</h1>
      <p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-muted">
        Registration is invite-only. Your invitation must match this email
        address and has not been used before.
      </p>

      <form className="mt-8" onSubmit={onSubmit} aria-describedby="signup-form-note">
        <p id="signup-form-note" className="sr-only">
          All fields are required. Passwords must be at least 12 characters.
        </p>

        <Stack gap={5}>
          <TextField
            id="signup-email"
            name="email"
            type="email"
            label="Email address"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <TextField
            id="signup-password"
            name="password"
            type="password"
            label="Password"
            autoComplete="new-password"
            minLength={12}
            required
            hint="At least 12 characters. Do not use your email address as the password."
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <TextField
            id="signup-invite"
            name="inviteToken"
            type="text"
            label="Invitation token"
            autoComplete="off"
            spellCheck={false}
            required
            hint="Invitations are issued out of band. Ask the Habi maintainer if you need one."
            inputClassName="font-mono text-sm"
            value={inviteToken}
            onChange={(event) => setInviteToken(event.target.value)}
          />
        </Stack>

        <Button type="submit" block loading={pending} className="mt-6">
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>

      <FormMessage error={error} status={status} />

      <nav
        className="mt-8 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-4 text-sm"
        aria-label="Other account actions"
      >
        <Link className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline" href="/login">
          Log in instead
        </Link>
        <Link className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline" href="/recovery">
          Recover access
        </Link>
      </nav>
    </div>
  );
}
