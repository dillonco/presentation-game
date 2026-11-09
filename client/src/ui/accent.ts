import { useEffect } from 'react';
import type { AccentColours } from '../../../shared/color.js';

/** A deck can bring its own accent. The server has already checked it's readable. */
export function useAccent(accent: AccentColours | null | undefined): void {
  const light = accent?.light;
  const dark = accent?.dark;
  useEffect(() => {
    if (!light || !dark) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', light);
    root.style.setProperty('--accent-on-dark', dark);
  }, [light, dark]);
}
