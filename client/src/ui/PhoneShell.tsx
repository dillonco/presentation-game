import { useEffect, type ReactNode } from 'react';

/** Keeps the app sized to the part of the screen the keyboard isn't covering. */
function useVisibleScreen(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const update = () => {
      root.style.setProperty('--app-h', `${viewport ? viewport.height : window.innerHeight}px`);
      root.style.setProperty('--app-top', `${viewport ? viewport.offsetTop : 0}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
}

export function PhoneShell({ children, offline = false }: { children: ReactNode; offline?: boolean }) {
  useVisibleScreen();
  return (
    <div className="shell">
      {offline ? (
        <div className="banner" role="status">
          Reconnecting…
        </div>
      ) : null}
      {children}
    </div>
  );
}
