import { lazy, useEffect, type ComponentType } from 'react';

/**
 * A map left out of the first download. If the map engine can't arrive, the stand-in calls
 * `onFail`, and the caller shows its fallback instead.
 */
export function lazyMap<Props extends { onFail: () => void }>(load: () => Promise<{ default: ComponentType<Props> }>) {
  return lazy(() =>
    load().catch(() => ({
      default: ({ onFail }: Props) => {
        useEffect(onFail, [onFail]);
        return null;
      },
    })),
  );
}

/** Fetches a map and its country's outline ahead of time, so the game never waits on them. */
export function usePreloadedMap(country: string | null | undefined, load: () => Promise<unknown>): void {
  useEffect(() => {
    if (!country) return;
    void load().catch(() => undefined);
    void import('./outline.js').then((module) => module.loadOutline(country)).catch(() => undefined);
    // Only a new country needs fetching again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);
}
