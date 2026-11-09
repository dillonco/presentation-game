import { useEffect, useState } from 'react';
import type { Outline } from '../../../shared/geo.js';

export interface OutlineState {
  outline: Outline | null;
  /** False until it has either arrived or failed. */
  settled: boolean;
}

/** Without its outline a map still works, and the server still checks every pin. */
export function useOutline(country: string): OutlineState {
  const [state, setState] = useState<OutlineState>({ outline: null, settled: false });
  useEffect(() => {
    let live = true;
    void import('./outline.js')
      .then((module) => module.loadOutline(country))
      .catch(() => null)
      .then((outline) => {
        if (live) setState({ outline, settled: true });
      });
    return () => {
      live = false;
    };
  }, [country]);
  return state;
}
