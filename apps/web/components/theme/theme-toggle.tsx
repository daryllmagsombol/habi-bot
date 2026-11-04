'use client';

import { motion, useReducedMotion } from 'motion/react';
import { MoonIcon, SunIcon } from '../ui/icons';
import { EASE, DURATION } from '../../lib/motion';
import { setTheme, useTheme } from './theme';

export interface ThemeToggleProps {
  readonly className?: string;
}

/**
 * Light/dark switch for the top bar.
 *
 * The accessible name states the action, not the current state, so a screen
 * reader announces "Switch to dark theme" while the page is light — a control
 * that says only "theme" makes the reader guess what pressing it does. The
 * choice is persisted and applied before paint by the root script; with no
 * choice, the page follows the operating system.
 */
export function ThemeToggle({ className }: Readonly<ThemeToggleProps>) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;

  return (
    <motion.button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
      whileTap={{ scale: reduceMotion === true ? 1 : 0.94 }}
      className={[
        'grid size-11 shrink-0 place-items-center rounded-sm text-muted',
        'transition-colors duration-[var(--habi-duration-fast)] ease-standard',
        'hover:bg-sunken hover:text-ink',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <motion.span
        key={theme}
        initial={reduceMotion === true ? false : { opacity: 0, rotate: -25, scale: 0.85 }}
        animate={{ opacity: 1, rotate: 0, scale: 1 }}
        transition={{ duration: DURATION.fast, ease: EASE }}
        className="grid place-items-center"
      >
        {theme === 'dark' ? <SunIcon size={17} /> : <MoonIcon size={17} />}
      </motion.span>
    </motion.button>
  );
}
