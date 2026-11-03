import Link from 'next/link';

/**
 * Auth landing. The root `/` remains the foundation page owned elsewhere; this
 * page is the entry point for the identity preview and intentionally promises
 * only what this slice implements.
 */
export default function StartPage() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <p className="text-sm font-medium tracking-wide text-[var(--muted)] uppercase">
        Identity preview
      </p>
      <h1 className="mt-3 max-w-[18ch] text-4xl leading-tight font-medium tracking-tight text-balance sm:text-5xl">
        Sign in to Habi.
      </h1>
      <p className="mt-5 max-w-prose text-base leading-relaxed text-[var(--muted)]">
        Habi is an early proof-of-concept workspace. Accounts are invite-only
        while the foundation is under construction. This preview covers
        email/password signup, login, logout, and recovery requests only.
      </p>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-[var(--muted)]">
        It does not include single sign-on, chat, Bots, model calls, or Hermes.
        No product workspace is available yet.
      </p>

      <nav className="mt-8" aria-label="Account access">
        <ul className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <li>
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--ink)] px-5 py-2.5 text-sm font-medium text-[var(--paper)] hover:opacity-90"
              href="/login"
            >
              Log in
            </Link>
          </li>
          <li>
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-[var(--line)] px-5 py-2.5 text-sm font-medium hover:border-[var(--ink)]"
              href="/signup"
            >
              Create an account
            </Link>
          </li>
          <li>
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-md px-5 py-2.5 text-sm font-medium underline underline-offset-4 hover:text-[var(--ink)]"
              href="/recovery"
            >
              Recover access
            </Link>
          </li>
        </ul>
      </nav>

      <section className="mt-10 border-t border-[var(--line)] pt-6" aria-labelledby="preview-boundary">
        <h2 id="preview-boundary" className="text-base font-semibold">
          What this preview does
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--muted)]">
          <li>Creates an account only with a valid, unused invitation.</li>
          <li>Signs in with an email address and a password of at least 12 characters.</li>
          <li>Records a recovery request without revealing whether an account exists.</li>
          <li>Does not send email yet; recovery delivery is not enabled.</li>
        </ul>
      </section>
    </div>
  );
}
