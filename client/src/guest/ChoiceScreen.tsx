import type { ChoiceRoundResult, ErrorCode, GuestScreen } from '../../../shared/protocol.js';
import { toLocalTimes } from '../net/clock.js';
import { GAME_NAMES, roundPosition } from '../theme/games.js';
import { OptionBox } from '../ui/OptionBox.js';
import { PhotoThumb } from '../ui/Photo.js';
import { StatusArea } from '../ui/StatusArea.js';
import { TimerStrip } from '../ui/TimerStrip.js';
import { choiceStatus, useInstantChoice } from './useInstantChoice.js';
import {
  letterFor,
  LookUp,
  ordinal,
  stripLabel,
  useAtDeadline,
  useHeldUntil,
  type RoundSession,
} from './RoundScreens.js';

type PickData = Extract<GuestScreen, { kind: 'pick' }>;
type PickRevealData = Extract<GuestScreen, { kind: 'pickReveal' }>;

function messageFor(code: ErrorCode): string {
  if (code === 'too_late') return 'Time ran out. Your last sent answer counts.';
  if (code === 'slow_down') return 'That was a lot of tries. Wait a moment, then try again.';
  return "That didn't work. Try again.";
}

/** Pick one: the photo, the question and four answers. A tap sends the answer, and another changes it. */
export function PickScreen({ screen, screenId, session }: { screen: PickData; screenId: number; session: RoundSession }) {
  const picked = useInstantChoice<number>({
    saved: screen.pick,
    send: (option) => session.sendPick(screenId, screen.lastSeq, option),
    messageFor,
  });
  const { choice } = picked;

  // A tap that didn't get through is tried once more as time runs out.
  useAtDeadline(screen.timer, session.offset, () => {
    if (choice !== null && choice !== screen.pick && !picked.sending) picked.choose(choice);
  });

  const status = choiceStatus(picked, screen.pick);

  const { round } = screen;
  return (
    <main className="round">
      <TimerStrip
        {...toLocalTimes(screen.timer, session.offset)}
        label={stripLabel(session, picked.slow, `${GAME_NAMES[round.game]} · ${roundPosition(round)}`)}
      />
      <div className="round-pad">
        {round.image ? <PhotoThumb image={round.image} alt={roundPosition(round)} vote /> : null}
        <h1 className="round-prompt choice-question">{round.prompt || 'Which one is right?'}</h1>
        <div className="opts vote-list" role="radiogroup" aria-label="Answers">
          {screen.options.map((option, index) => (
            <OptionBox
              key={index}
              letter={letterFor(index)}
              text={option}
              selected={choice === index}
              onSelect={() => {
                if (choice !== index || choice !== screen.pick) picked.choose(index);
              }}
            />
          ))}
        </div>
        <StatusArea content={status} />
      </div>
    </main>
  );
}

function resultLine(result: ChoiceRoundResult): string {
  if (!result.picked) return 'No answer this time';
  return result.correct ? 'You got it' : 'Not this time';
}

export function PickRevealScreen({ screen, offset }: { screen: PickRevealData; offset: number }) {
  const revealed = useHeldUntil(screen.endsAt - offset);
  const { round, result } = screen;
  if (!revealed) return <LookUp round={round} body="The answer is on its way." />;
  return (
    <main className="sheet">
      <div className="waiting">
        <div className="waiting-main">
          <p className="kicker">The answer: {screen.answer}</p>
          <h1 className="notice-title">{resultLine(result)}</h1>
          <p className="result-points">+{result.points}</p>
        </div>
        <div className="waiting-foot">
          <span>Total {result.total}</span>
          <span>{ordinal(result.rank)} place</span>
        </div>
      </div>
    </main>
  );
}
