import { formatSeconds, Sunbar, useCountdown, type CountdownInput } from './Sunbar.js';

interface TimerStripProps extends CountdownInput {
  label: string;
}

/** The strip at the top of a phone. It stays visible above the keyboard. */
export function TimerStrip({ label, ...times }: TimerStripProps) {
  const countdown = useCountdown(times);
  const { seconds, done, paused } = countdown;
  let shownLabel = label;
  if (done) shownLabel = "Time's up";
  else if (paused) shownLabel = 'Paused';

  return (
    <div className="strip">
      <div className="strip-row">
        <span className={seconds <= 10 ? 'strip-digits last' : 'strip-digits'} aria-hidden="true">
          {formatSeconds(seconds)}
        </span>
        <span className="strip-label">{shownLabel}</span>
        <span className="sr-only" role="timer" aria-live={seconds === 30 || seconds === 10 ? 'polite' : 'off'}>
          {seconds} {seconds === 1 ? 'second' : 'seconds'} left
        </span>
      </div>
      <Sunbar countdown={countdown} />
    </div>
  );
}
