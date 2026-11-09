import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface Wash {
  key: number;
  x: number;
  y: number;
  size: number;
}

/**
 * The pressed look shared by buttons and option boxes: goes in at once and
 * spreads an ink wash from the exact point of contact. Size never changes.
 */
export function usePress(busy = false) {
  const [down, setDown] = useState(false);
  const [wash, setWash] = useState<Wash | null>(null);
  const [fading, setFading] = useState(false);
  const counter = useRef(0);

  const start = useCallback((element: HTMLElement, clientX?: number, clientY?: number) => {
    const box = element.getBoundingClientRect();
    const x = clientX === undefined ? box.width / 2 : clientX - box.left;
    const y = clientY === undefined ? box.height / 2 : clientY - box.top;
    // Big enough to reach the far corner from wherever the finger landed.
    const reach = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));
    counter.current += 1;
    setFading(false);
    setWash({ key: counter.current, x, y, size: reach * 2 });
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      setDown(true);
      start(event.currentTarget, event.clientX, event.clientY);
      // A tiny haptic tap on Android. iOS ignores it.
      if (event.pointerType === 'touch') navigator.vibrate?.(8);
    },
    [start],
  );

  const release = useCallback(() => setDown(false), []);

  // The wash stays while waiting on the server, then fades once the action finishes.
  useEffect(() => {
    if (down || busy || !wash) return;
    const fade = window.setTimeout(() => setFading(true), 300);
    const clear = window.setTimeout(() => setWash(null), 560);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(clear);
    };
  }, [down, busy, wash]);

  return {
    down,
    wash,
    fading,
    /** For keyboard use, which has no point of contact. */
    pressFromCentre: start,
    pressHandlers: {
      onPointerDown,
      onPointerUp: release,
      onPointerCancel: release,
      onPointerLeave: release,
    },
  };
}
