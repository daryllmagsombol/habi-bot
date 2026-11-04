import localFont from 'next/font/local';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/*
 * Self-hosted variable faces. Outfit carries display and titles; Work Sans
 * carries everything read or operated. Both files live in the repository, so the
 * build and the browser make no font request, and the preview keeps working
 * offline.
 */
const outfit = localFont({
  src: './fonts/outfit-latin-variable.woff2',
  variable: '--font-outfit',
  weight: '300 700',
  display: 'swap',
  fallback: ['Avenir Next', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

const workSans = localFont({
  src: './fonts/work-sans-latin-variable.woff2',
  variable: '--font-work-sans',
  weight: '300 600',
  display: 'swap',
  fallback: ['Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

/*
 * Runs before the first paint. An explicit choice is applied to `<html>` here,
 * which is what keeps a dark-mode reader from seeing a light flash on reload.
 * With no stored choice the attribute stays off and CSS follows
 * `prefers-color-scheme`; nothing is written to storage until the reader uses
 * the toggle.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('habi-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export const metadata: Metadata = {
  title: {
    default: 'Habi — Interface preview',
    template: '%s — Habi',
  },
  description:
    'A local interface preview for Habi: a Bot gallery, threads, and the document and context around them. Sample data only.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f4f1' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1114' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${outfit.variable} ${workSans.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
