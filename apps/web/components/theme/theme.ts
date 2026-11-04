'use client';

import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'habi-theme';
const CHANGE_EVENT = 'habi:theme-change';

/*
 * The resolved theme is the `<html data-theme>` attribute when the reader has
 * made an explicit choice, and the operating-system preference otherwise. The
 * attribute is written before first paint by the inline script in the root
 * layout, so a stored choice never flashes the other theme.
 */
function readAttribute(): Theme | undefined {
  const value = document.documentElement.dataset.theme;
  return value === 'dark' || value === 'light' ? value : undefined;
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function currentTheme(): Theme {
  if (typeof document === 'undefined') {
    return 'light';
  }

  return readAttribute() ?? systemTheme();
}

function readStored(): Theme | undefined {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : undefined;
  } catch {
    return undefined;
  }
}

function syncFromStorage(): void {
  const stored = readStored();

  if (stored === undefined) {
    delete document.documentElement.dataset.theme;
    return;
  }

  document.documentElement.dataset.theme = stored;
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const onStorage = () => {
    syncFromStorage();
    onChange();
  };

  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  media.addEventListener('change', onChange);

  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
    media.removeEventListener('change', onChange);
  };
}

function getServerSnapshot(): Theme {
  return 'light';
}

/** The theme currently painted, kept in sync with the attribute and the OS. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, getServerSnapshot);
}

/** Applies a theme immediately and remembers the choice across visits. */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;

  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // A blocked storage API must not break the toggle; the theme still applies
    // for this page view.
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
}
