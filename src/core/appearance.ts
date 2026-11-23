import type { Settings } from './types';

/** Applies a shared skin and color mode to either extension surface. */
export function applyAppearance(
  settings: Pick<Settings, 'theme' | 'skin'> | undefined,
): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const update = () => {
    root.dataset.theme =
      settings?.theme === 'dark' || (settings?.theme === 'system' && media.matches)
        ? 'dark'
        : 'light';
    root.dataset.skin = settings?.skin === 'elysia' ? 'elysia' : 'forest';
  };
  update();
  media.addEventListener('change', update);
  return () => media.removeEventListener('change', update);
}
