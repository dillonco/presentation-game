import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MAX_NAME_LENGTH } from '../../../shared/constants.js';
import type { ErrorCode, GuestView, JoinState, RejoinResult } from '../../../shared/protocol.js';
import { safeStorage } from '../net/socket.js';
import { answerName, GAME_NAMES, GAME_NUMERALS } from '../theme/games.js';
import '../theme/components.css';
import '../theme/phone.css';
import { ActionButton, useLockedAction } from '../ui/ActionButton.js';
import { useAccent } from '../ui/accent.js';
import { PhoneShell } from '../ui/PhoneShell.js';
import { StatusArea, type StatusContent } from '../ui/StatusArea.js';
import { PickRevealScreen, PickScreen } from './ChoiceScreen.js';
import { GuessScreen, PinRevealScreen } from './GuessScreen.js';
import { FinalScreen, LookUp, RankScreen, RevealScreen, VoteScreen, WriteScreen, type RoundSession } from './RoundScreens.js';
import { TipsScreen } from './TipsScreen.js';
import { useGuestSession, useKeepAwake } from './useGuestSession.js';
import { APP_NAME } from '../appName.js';

const MESSAGES: Partial<Record<ErrorCode | RejoinResult, string>> = {
  name_empty: 'Enter a name with at least one letter or number.',
  name_too_long: `Use ${MAX_NAME_LENGTH} characters or fewer.`,
  name_blocked: 'Try a different name.',
  name_taken: 'Someone is using that name. Try adding an initial.',
  rejoin_busy: 'Someone is already asking to use that name. Try again in a moment.',
  join_locked: 'Joining is closed. Ask the presenter to open it.',
  room_full: 'The game is full. Ask the presenter to make room.',
  slow_down: 'That was a lot of tries. Wait a moment, then try again.',
  bad_request: "That didn't work. Refresh the page and try again.",
  denied: 'The presenter said no. Try a different name.',
  expired: 'No answer from the presenter. Try again.',
  cancelled: 'That player came back. Try a different name.',
};

function messageFor(code: ErrorCode | RejoinResult): string {
  return MESSAGES[code] ?? "That didn't work. Try again.";
}

function JoinScreen({
  room,
  title,
  joinState,
  notice,
  join,
}: {
  room: string;
  title: string;
  joinState: JoinState;
  notice?: ErrorCode | RejoinResult;
  join: (name: string) => Promise<ErrorCode | null>;
}) {
  const draftKey = `tp:name:${room}`;
  const [name, setName] = useState(() => safeStorage.get(draftKey) ?? '');
  const [error, setError] = useState<ErrorCode | RejoinResult | null>(notice ?? null);
  const [weak, setWeak] = useState(false);
  const inputId = useId();
  const statusId = useId();
  const input = useRef<HTMLInputElement>(null);

  const action = useLockedAction(async () => {
    if (name.trim() === '') {
      setError('name_empty');
      return;
    }
    const code = await join(name);
    setError(code);
    if (code) {
      // Keeps the keyboard open with the cursor at the end, ready to edit.
      input.current?.focus();
      input.current?.setSelectionRange(name.length, name.length);
    }
  });

  let status: StatusContent = { kind: 'empty' };
  if (error) status = { kind: 'error', text: messageFor(error) };
  else if (weak) status = { kind: 'hint', text: 'Weak connection. Your name will send when it recovers.' };
  else if (joinState === 'locked') status = { kind: 'hint', text: 'Joining is closed. Already playing? Enter the same name.' };
  else if (joinState === 'full') status = { kind: 'hint', text: 'The game is full. Already playing? Enter the same name.' };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    action.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Holding Return must not send repeatedly.
    if (event.key === 'Enter' && event.repeat) event.preventDefault();
  };

  return (
    <main className="sheet">
      <header className="masthead">
        <p className="kicker">{APP_NAME}</p>
        <h1 className="deck-title">{title}</h1>
      </header>
      <form className="join-form" onSubmit={onSubmit} noValidate>
        <label className="field-label" htmlFor={inputId}>
          Your name
        </label>
        <input
          ref={input}
          id={inputId}
          className="field-input"
          value={name}
          maxLength={MAX_NAME_LENGTH + 4}
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="go"
          aria-invalid={error ? true : undefined}
          aria-describedby={statusId}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setName(event.target.value);
            safeStorage.set(draftKey, event.target.value);
            setError(null);
          }}
        />
        <StatusArea id={statusId} content={status} />
        <ActionButton action={action} label="Join game" busyLabel="Joining…" onSlowChange={setWeak} />
      </form>
    </main>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="sheet">
      <div className="notice">
        <h1 className="notice-title">{title}</h1>
        <p className="notice-body">{body}</p>
      </div>
    </main>
  );
}

function InGame({ view, session }: { view: GuestView; session: RoundSession }) {
  const { screen } = view;
  if (screen.kind === 'lobby') {
    return (
      <main className="sheet">
        <div className="waiting">
          <div className="waiting-main">
            <div className="waiting-stamp">
              <span className="seal" aria-hidden="true">
                済
              </span>
              <p className="locked-text">You're in</p>
            </div>
            <h1 className="waiting-name">{view.you.name}</h1>
            <p className="notice-body">Watch the TV. The game starts soon.</p>
          </div>
          <div className="waiting-foot">
            <span>{view.title}</span>
            <span>
              {view.playerCount} of {view.capacity} here
            </span>
          </div>
        </div>
      </main>
    );
  }
  if (screen.kind === 'title') {
    return (
      <main className="sheet">
        <div className="game-card">
          <p className="game-numeral" aria-hidden="true">
            {GAME_NUMERALS[screen.gameNumber - 1] ?? screen.gameNumber}
          </p>
          <h1 className="notice-title">{GAME_NAMES[screen.game]}</h1>
          <p className="notice-body">Look up at the TV.</p>
        </div>
      </main>
    );
  }
  if (screen.kind === 'write') return <WriteScreen key={view.screenId} screen={screen} screenId={view.screenId} session={session} />;
  if (screen.kind === 'show') {
    return (
      <LookUp
        round={screen.round}
        body={`${answerName(screen.round)} ${screen.number} of ${screen.count}. You'll vote once they've all been shown.`}
      />
    );
  }
  if (screen.kind === 'vote') return <VoteScreen key={view.screenId} screen={screen} screenId={view.screenId} session={session} />;
  if (screen.kind === 'reveal') return <RevealScreen screen={screen} offset={session.offset} />;
  if (screen.kind === 'guess') {
    return <GuessScreen key={view.screenId} screen={screen} screenId={view.screenId} area={view.mapArea!} session={session} />;
  }
  if (screen.kind === 'pinReveal') return <PinRevealScreen screen={screen} offset={session.offset} />;
  if (screen.kind === 'pick') return <PickScreen key={view.screenId} screen={screen} screenId={view.screenId} session={session} />;
  if (screen.kind === 'pickReveal') return <PickRevealScreen screen={screen} offset={session.offset} />;
  if (screen.kind === 'gallery') {
    return (
      <LookUp
        round={screen.round}
        body={`${screen.count === 1 ? 'One more photo' : `${screen.count} more photos`} from this one, on the TV.`}
      />
    );
  }
  if (screen.kind === 'standings') {
    return (
      <RankScreen
        heading={`After ${GAME_NAMES[screen.game]}`}
        rank={screen.rank}
        score={screen.score}
        playerCount={screen.playerCount}
      />
    );
  }
  if (screen.kind === 'tips') return <TipsScreen screen={screen} title={view.title} />;
  return <FinalScreen screen={screen} offset={session.offset} />;
}

/** Fetched quietly once a guest is in, so the map is ready before its game starts. */
function usePreloadedMap(country: string | null): void {
  useEffect(() => {
    if (!country) return;
    void import('../map/PinMap.js').catch(() => undefined);
    void import('../map/outline.js').then((module) => module.loadOutline(country)).catch(() => undefined);
  }, [country]);
}

const GONE: Record<'removed' | 'superseded' | 'ended' | 'missing', [string, string]> = {
  removed: ['You were removed from this game', 'Talk to the presenter if this is a mistake.'],
  superseded: ["You're playing on another phone", 'This phone is no longer in the game.'],
  ended: ['This game has ended', 'The presenter closed it. Thanks for playing!'],
  missing: ["This game isn't running", 'Scan the QR code on the TV again.'],
};

export default function GuestApp({ room }: { room: string }) {
  const { stage, online, offset, join, sendAnswer, sendVote, sendPin, sendPick } = useGuestSession(room);
  useKeepAwake(stage.stage === 'in');
  usePreloadedMap(stage.stage === 'in' ? (stage.view.mapArea?.name ?? null) : null);
  const offline = !online && stage.stage !== 'connecting' && stage.stage !== 'gone';
  // A timed screen says this in its strip instead, so the banner never covers the clock.
  useAccent(stage.stage === 'in' ? stage.view.accent : null);
  const kind = stage.stage === 'in' ? stage.view.screen.kind : null;
  const banner = offline && kind !== 'write' && kind !== 'vote' && kind !== 'guess' && kind !== 'pick';

  return (
    <PhoneShell offline={banner}>
      {stage.stage === 'connecting' ? <Notice title="Connecting…" body="This only takes a moment." /> : null}
      {stage.stage === 'form' ? (
        <JoinScreen
          key={stage.notice ?? 'form'}
          room={room}
          title={stage.title}
          joinState={stage.joinState}
          notice={stage.notice}
          join={join}
        />
      ) : null}
      {stage.stage === 'pending' ? (
        <Notice
          title="Asking the presenter"
          body="Your name is on the TV. You'll be back in as soon as they approve it."
        />
      ) : null}
      {stage.stage === 'in' ? (
        <InGame view={stage.view} session={{ room, offset, offline, sendAnswer, sendVote, sendPin, sendPick }} />
      ) : null}
      {stage.stage === 'gone' ? <Notice title={GONE[stage.reason][0]} body={GONE[stage.reason][1]} /> : null}
    </PhoneShell>
  );
}
