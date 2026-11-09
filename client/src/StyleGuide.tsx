import { useState } from 'react';
import './theme/components.css';
import './theme/phone.css';
import './theme/styleguide.css';
import { choiceStatus, useInstantChoice } from './guest/useInstantChoice.js';
import { ActionButton, useLockedAction } from './ui/ActionButton.js';
import { OptionBox } from './ui/OptionBox.js';
import { StatusArea } from './ui/StatusArea.js';
import { TimerStrip } from './ui/TimerStrip.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ANSWERS = [
  'Sunlight filtering through the leaves of trees',
  'A shared meal after the first snowfall',
  'The sound of rain on a paper umbrella',
];

function Phone({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <figure className="sg-item">
      <figcaption>{title}</figcaption>
      <div className="sg-phone">{children}</div>
    </figure>
  );
}

function WritingScreen({ endsAt, startsAt }: { startsAt: number; endsAt: number }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  const action = useLockedAction(async () => {
    if (sent) {
      setSent(false);
      return;
    }
    await wait(900);
    if (text.trim().toLowerCase().includes('sunlight')) setError(true);
    else setSent(true);
  });
  return (
    <>
      <TimerStrip startsAt={startsAt} endsAt={endsAt} label="Define it · Word 3 of 5" />
      <div className="sg-pad">
        <p className="sg-prompt">komorebi</p>
        <label className="field-label" htmlFor="sg-answer">
          Your fake definition
        </label>
        <textarea
          id="sg-answer"
          className="field-input"
          rows={3}
          value={text}
          readOnly={sent}
          maxLength={140}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setError(false);
          }}
        />
        <StatusArea
          content={
            sent
              ? { kind: 'locked' }
              : error
                ? { kind: 'error', text: 'Too close to another answer. Try something different.' }
                : { kind: 'empty' }
          }
        />
        <ActionButton action={action} label={sent ? 'Edit answer' : 'Send'} />
      </div>
    </>
  );
}

function VotingScreen({ endsAt, startsAt }: { startsAt: number; endsAt: number }) {
  const [saved, setSaved] = useState<number | null>(null);
  const picked = useInstantChoice<number>({
    saved,
    send: async (index) => {
      await wait(900);
      setSaved(index);
      return { ok: true };
    },
    messageFor: () => "That didn't work. Try again.",
  });
  return (
    <>
      <TimerStrip startsAt={startsAt} endsAt={endsAt} label="Which one is real?" />
      <div className="sg-pad sg-grow">
        <div className="opts sg-list" role="radiogroup" aria-label="Definitions">
          {ANSWERS.map((text, index) => (
            <OptionBox
              key={text}
              letter={String.fromCharCode(65 + index)}
              text={text}
              selected={picked.choice === index}
              onSelect={() => {
                if (picked.choice !== index || picked.choice !== saved) picked.choose(index);
              }}
            />
          ))}
        </div>
        <StatusArea content={choiceStatus(picked, saved)} />
      </div>
    </>
  );
}

export default function StyleGuide() {
  const [times, setTimes] = useState(() => ({ startsAt: Date.now(), endsAt: Date.now() + 45_000 }));
  const [lastTen] = useState(() => ({ startsAt: Date.now() - 50_000, endsAt: Date.now() + 10_000 }));
  return (
    <main className="sg">
      <header className="sg-head">
        <h1>Paper and panel</h1>
        <p>
          The real components, on real phone sizes. Press everything. Answers containing "sunlight" are flagged as too
          similar.
        </p>
        <button type="button" className="sg-reset" onClick={() => setTimes({ startsAt: Date.now(), endsAt: Date.now() + 45_000 })}>
          Restart timer
        </button>
      </header>
      <div className="sg-grid">
        <Phone title="Writing">
          <WritingScreen {...times} />
        </Phone>
        <Phone title="Voting, last 10 seconds">
          <VotingScreen {...lastTen} />
        </Phone>
      </div>
    </main>
  );
}
