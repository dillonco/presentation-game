import { usePress } from './press.js';
import { WashLayer } from './ActionButton.js';

interface OptionBoxProps {
  letter: string;
  text: string;
  selected: boolean;
  /** A tap sends the choice straight away, and tapping another changes it. */
  onSelect: () => void;
}

export function OptionBox({ letter, text, selected, onSelect }: OptionBoxProps) {
  const { down, wash, fading, pressHandlers } = usePress();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={down ? 'opt down' : 'opt'}
      onClick={onSelect}
      {...pressHandlers}
    >
      <WashLayer wash={wash} fading={fading} />
      <span className="chip" aria-hidden="true">
        {letter}
      </span>
      <span className="opt-text">{text}</span>
    </button>
  );
}
