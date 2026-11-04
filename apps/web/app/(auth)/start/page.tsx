import Link from 'next/link';
import { ButtonLink } from '../../../components/ui/button';

/**
 * Identity landing. The root `/` is the repository landing; this page is the
 * entry point for the identity preview and promises only what this slice
 * renders. The product workspace is not behind the sign-in yet.
 */
export default function StartPage() {
  return (
    <div>
      <h1 className="max-w-[18ch] text-page tracking-heading text-ink">Sign in to Habi.</h1>
      <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-muted">
        Habi is an early proof-of-concept workspace. Accounts are invite-only
        while the foundation is under construction. This preview covers
        email/password signup, login, logout, and recovery requests only.
      </p>
      <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-muted">
        It does not include single sign-on, chat, Bots, model calls, or Hermes.
        No product workspace is available behind the sign-in yet.
      </p>

      <nav className="mt-8" aria-label="Account access">
        <ul className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <li>
            <ButtonLink href="/login" block className="sm:w-auto">
              Log in
            </ButtonLink>
          </li>
          <li>
            <ButtonLink href="/signup" variant="secondary" block className="sm:w-auto">
              Create an account
            </ButtonLink>
          </li>
          <li>
            <ButtonLink href="/recovery" variant="ghost" className="justify-center">
              Recover access
            </ButtonLink>
          </li>
        </ul>
      </nav>

      <section className="mt-10 border-t border-line pt-6" aria-labelledby="preview-boundary">
        <h2 id="preview-boundary" className="text-title tracking-heading text-ink">
          What this preview does
        </h2>
        <ul className="mt-3 border-t border-line text-sm leading-relaxed text-muted">
          <li className="border-b border-line py-2.5">
            Creates an account only with a valid, unused invitation.
          </li>
          <li className="border-b border-line py-2.5">
            Signs in with an email address and a password of at least 12 characters.
          </li>
          <li className="border-b border-line py-2.5">
            Records a recovery request without revealing whether an account exists.
          </li>
          <li className="border-b border-line py-2.5">
            Does not send email yet; recovery delivery is not enabled.
          </li>
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Looking for the interface preview?{' '}
          <Link href="/bots" className="underline underline-offset-4 hover:no-underline">
            Open the Bot gallery
          </Link>
          . It runs on local sample data.
        </p>
      </section>
    </div>
  );
}
