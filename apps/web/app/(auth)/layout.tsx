import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Habi — Identity preview',
  description:
    'Invite-only identity preview for Habi: email/password signup, login, and recovery.',
};

export default function AuthLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="foundation mx-auto flex min-h-svh w-full max-w-6xl flex-col">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="masthead flex flex-wrap items-center justify-between gap-4">
        <Link className="wordmark" href="/">
          Habi
        </Link>
        <span className="preview-label">Identity preview</span>
      </header>

      <main id="main-content" tabIndex={-1} className="flex-1 py-10 sm:py-16">
        {children}
      </main>

      <footer className="footer flex flex-wrap justify-between gap-3">
        <span>Habi · Identity preview</span>
        <span>Invite-only while the POC is under construction.</span>
      </footer>
    </div>
  );
}
