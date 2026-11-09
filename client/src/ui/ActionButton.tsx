import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { usePress, type Wash } from './press.js';

export interface LockedAction {
  run: () => void;
  busy: boolean;
}

/**
 * Locks the moment it's pressed and stays locked until the action finishes,
 * rather than for a fixed delay, so extra taps do nothing on a slow connection.
 * Shared with the keyboard's Return key, so holding it can't send twice.
 */
export function useLockedAction(action: () => Promise<unknown> | unknown): LockedAction {
  const latest = useRef(action);
  latest.current = action;
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(() => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    void (async () => {
      try {
        await latest.current();
      } finally {
        locked.current = false;
        setBusy(false);
      }
    })();
  }, []);

  return { run, busy };
}

export function WashLayer({ wash, fading }: { wash: Wash | null; fading: boolean }) {
  if (!wash) return null;
  return (
    <span
      key={wash.key}
      aria-hidden="true"
      className={fading ? 'wash fade' : 'wash'}
      style={{
        left: wash.x - wash.size / 2,
        top: wash.y - wash.size / 2,
        width: wash.size,
        height: wash.size,
      }}
    />
  );
}

const SLOW_AFTER_MS = 3000;

interface ActionButtonProps {
  action: LockedAction;
  label: string;
  busyLabel?: string;
  slowLabel?: string;
  /** Called once the wait passes 3 seconds, to show a weak connection. */
  onSlowChange?: (slow: boolean) => void;
}

export function ActionButton({
  action,
  label,
  busyLabel = 'Sending…',
  slowLabel = 'Still sending…',
  onSlowChange,
}: ActionButtonProps) {
  const { down, wash, fading, pressHandlers, pressFromCentre } = usePress(action.busy);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!action.busy) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [action.busy]);

  useEffect(() => onSlowChange?.(slow), [slow, onSlowChange]);

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // A keyboard press arrives as a click with no pointer.
    if (event.detail === 0) pressFromCentre(event.currentTarget);
    action.run();
  };

  return (
    <button
      type="button"
      className={down ? 'act down' : 'act'}
      aria-busy={action.busy}
      aria-disabled={action.busy}
      onClick={onClick}
      // Stops the tap taking focus from the text box, which would close the keyboard
      // before the tap registers: a common mobile bug.
      onMouseDown={(event) => event.preventDefault()}
      {...pressHandlers}
    >
      <WashLayer wash={wash} fading={fading} />
      <span className="lbl">{action.busy ? (slow ? slowLabel : busyLabel) : label}</span>
      {action.busy ? <span className="line" aria-hidden="true" /> : null}
    </button>
  );
}
