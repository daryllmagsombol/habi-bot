'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SubmitEvent } from 'react';
import { Button, FormMessage, Stack, TextField } from '../../../components/ui';
import { authErrorMessage, postAuth } from '../auth-client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
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
    <div>
      <h1 className="text-page tracking-heading text-ink">Log in</h1>
      <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-muted">
        Use the email address and password for your Habi account.
      </p>

      <form className="mt-8" onSubmit={onSubmit} aria-describedby="login-form-note">
        <p id="login-form-note" className="sr-only">
          All fields are required.
        </p>

        <Stack gap={5}>
          <TextField
            id="login-email"
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
            id="login-password"
            name="password"
            type="password"
            label="Password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Stack>

        <Button type="submit" block loading={pending} className="mt-6">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <FormMessage error={error} status={status} />

      <nav
        className="mt-8 flex flex-wrap gap-x-6 gap-y-1 border-t border-line pt-4 text-sm"
        aria-label="Other account actions"
      >
        <Link className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline" href="/signup">
          Create an account
        </Link>
        <Link className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline" href="/recovery">
          Recover access
        </Link>
      </nav>
    </div>
  );
}
