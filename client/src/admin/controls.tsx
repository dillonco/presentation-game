import { useEffect, useId, useState, type MouseEvent, type ReactNode } from 'react';
import { useLockedAction, WashLayer } from '../ui/ActionButton.js';
import { usePress } from '../ui/press.js';

interface KeyProps {
  label: string;
  /** What a screen reader says when the label alone wouldn't be clear, such as "Move word 2 up". */
  context?: string;
  busyLabel?: string;
  tone?: 'plain' | 'primary';
  /** Locks until the work is done, so an extra click does nothing. */
  onPress: () => unknown;
  disabled?: boolean;
  width?: 'wide';
}

/** A smaller hardware key for the builder, with the same press as the main button. */
export function Key({ label, context, busyLabel, tone = 'plain', onPress, disabled, width }: KeyProps) {
  const action = useLockedAction(onPress);
  const { down, wash, fading, pressHandlers, pressFromCentre } = usePress(action.busy);
  const classes = ['key', tone === 'primary' ? 'primary' : '', down ? 'down' : '', width === 'wide' ? 'wide' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      disabled={disabled}
      aria-busy={action.busy}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (event.detail === 0) pressFromCentre(event.currentTarget);
        action.run();
      }}
      {...pressHandlers}
    >
      <WashLayer wash={wash} fading={fading} />
      {context ? <span className="sr-only">{context}: </span> : null}
      <span className="lbl">{action.busy && busyLabel ? busyLabel : label}</span>
    </button>
  );
}

const CONFIRM_FOR_MS = 4000;

/** Asks once more in the same spot, without a pop-up that would interrupt the page. */
export function ConfirmKey({ label, confirmLabel, context, onConfirm }: {
  label: string;
  confirmLabel: string;
  context?: string;
  onConfirm: () => unknown;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <span className="confirm-slot">
      {/* The longer label sets the width, so the buttons beside it never shift. */}
      <span className="confirm-sizer" aria-hidden="true">
        {confirmLabel}
      </span>
      <Key
        label={armed ? confirmLabel : label}
        context={context}
        onPress={() => {
          if (armed) {
            setArmed(false);
            return onConfirm();
          }
          setArmed(true);
          return undefined;
        }}
      />
    </span>
  );
}

export function Field({ label, hint, children }: {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="desk-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint ? <p className="desk-hint">{hint}</p> : null}
    </div>
  );
}

/** Only passes on a number in range. Anything else snaps back when you leave the box. */
export function NumberField({ label, value, placeholder, min, max, onChange }: {
  label: string;
  value: number | undefined;
  placeholder: number;
  min: number;
  max: number;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  return (
    <Field label={label}>
      {(id) => (
        <input
          id={id}
          className="field-input"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          placeholder={String(placeholder)}
          value={draft}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            if (text === '') return onChange(undefined);
            const number = Number(text);
            if (Number.isInteger(number) && number >= min && number <= max) onChange(number);
          }}
          onBlur={() => setDraft(value === undefined ? '' : String(value))}
        />
      )}
    </Field>
  );
}
