import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/*
 * No web-font request: the shell is set in the rounded system face (SF Pro
 * Rounded on Apple platforms) and the body in the system sans. That keeps the
 * build and the browser offline-friendly, and it makes the type feel native on
 * every platform rather than shipping a look-alike.
 */

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
    { media: '(prefers-color-scheme: light)', color: '#fbfaf6' },
    { media: '(prefers-color-scheme: dark)', color: '#141317' },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
