import { lazy, Suspense, useState } from 'react';
import type { Country } from '../../../shared/countries.js';
import { insideOutline, type Spot } from '../../../shared/geo.js';
import type { ErrorCode, GuestScreen } from '../../../shared/protocol.js';
import { OutlineMap } from '../map/OutlineMap.js';
import { useOutline } from '../map/useOutline.js';
import { toLocalTimes } from '../net/clock.js';
import { safeStorage } from '../net/socket.js';
import { formatKm, GAME_NAMES, roundPosition } from '../theme/games.js';
import { ActionButton, useLockedAction } from '../ui/ActionButton.js';
import { PhotoThumb } from '../ui/Photo.js';
import { StatusArea, type StatusContent } from '../ui/StatusArea.js';
import { TimerStrip } from '../ui/TimerStrip.js';
import { LookUp, ordinal, stripLabel, useAtDeadline, useHeldUntil, type RoundSession } from './RoundScreens.js';

type GuessData = Extract<GuestScreen, { kind: 'guess' }>;
type PinRevealData = Extract<GuestScreen, { kind: 'pinReveal' }>;

/** Left out of the first download. If it can't arrive, the outline below still takes a pin. */
const PinMap = lazy(() =>
  import('../map/PinMap.js').catch(() => ({
    default: ({ area, outline, pin, onPick }: Parameters<typeof OutlineMap>[0]) => (
      <div className="map-fallback">
        <OutlineMap area={area} outline={outline} pin={pin} onPick={onPick} />
      </div>
    ),
  })),
);

function readDraft(key: string): Spot | null {
  try {
    const value = JSON.parse(safeStorage.get(key) ?? 'null') as Spot | null;
    return value && typeof value.lat === 'number' && typeof value.lng === 'number' ? value : null;
  } catch {
    return null;
  }
}

function sameSpot(a: Spot | null, b: Spot | null): boolean {
  return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
}

export function GuessScreen({
  screen,
  screenId,
  area,
  session,
}: {
  screen: GuessData;
  screenId: number;
  area: Country;
  session: RoundSession;
}) {
  const draftKey = `tp:pin:${session.room}:${screenId}`;
  const [draft, setDraft] = useState<Spot | null>(() => screen.pin ?? readDraft(draftKey));
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [weak, setWeak] = useState(false);
  const [noEngine, setNoEngine] = useState(false);
  const { outline, settled } = useOutline(area.name);
  const outside = `That's outside ${area.name}. Drop your pin in ${area.name}.`;

  const locked = screen.pin !== null && !editing;

  const pick = (spot: Spot) => {
    if (locked) return;
    if (outline && !insideOutline(outline, spot)) {
      setProblem(outside);
      return;
    }
    setDraft(spot);
    safeStorage.set(draftKey, JSON.stringify(spot));
    setProblem(null);
  };

  const messageFor = (code: ErrorCode): string => {
    if (code === 'outside_country') return outside;
    if (code === 'too_late') return 'Time ran out. Your last locked-in pin counts.';
    if (code === 'slow_down') return 'That was a lot of tries. Wait a moment, then try again.';
    return "That didn't work. Try again.";
  };

  const action = useLockedAction(async () => {
    if (locked) {
      setEditing(true);
      setProblem(null);
      return;
    }
    if (!draft) {
      setProblem('Tap the map to drop your pin first.');
      return;
    }
    const reply = await session.sendPin(screenId, screen.lastSeq, draft.lat, draft.lng);
    if (!reply) return;
    if (reply.ok) {
      setEditing(false);
      setProblem(null);
    } else if (reply.code !== 'stale_action') {
      setProblem(messageFor(reply.code));
    }
  });

  // A dropped pin counts even if nobody pressed the button in time.
  useAtDeadline(screen.timer, session.offset, () => {
    if (draft && !sameSpot(draft, screen.pin)) action.run();
  });

  let status: StatusContent;
  if (locked) status = { kind: 'locked' };
  else if (problem) status = { kind: 'error', text: problem };
  else if (draft) status = { kind: 'hint', text: 'Tap again to move it, then lock it in.' };
  else status = { kind: 'hint', text: 'Tap to drop your pin.' };

  const fallback = (
    <div className="map-fallback">
      <OutlineMap area={area} outline={outline} pin={draft} onPick={pick} />
    </div>
  );

  const { round } = screen;
  return (
    <main className="round">
      <TimerStrip
        {...toLocalTimes(screen.timer, session.offset)}
        label={stripLabel(session, weak, `${GAME_NAMES[round.game]} · ${roundPosition(round)}`)}
      />
      <div className="map-stage">
        {noEngine || !settled ? (
          fallback
        ) : (
          <Suspense fallback={fallback}>
            <PinMap
              area={area}
              outline={outline}
              pin={draft}
              locked={locked}
              onPick={pick}
              onFail={() => setNoEngine(true)}
            />
          </Suspense>
        )}
        <h1 className="sr-only">Where was this? {roundPosition(round)}</h1>
        {round.image ? <PhotoThumb image={round.image} alt={roundPosition(round)} onMap /> : null}
        <div className="map-foot">
          <StatusArea content={status} />
          <ActionButton action={action} label={locked ? 'Move pin' : 'Lock in pin'} onSlowChange={setWeak} />
        </div>
      </div>
    </main>
  );
}

function pinResultLine(km: number | null): string {
  if (km === null) return 'No pin this time';
  return km < 1 ? 'Right on the spot' : `${formatKm(km)} away`;
}

export function PinRevealScreen({ screen, offset }: { screen: PinRevealData; offset: number }) {
  const revealed = useHeldUntil(screen.endsAt - offset);
  const { round, result } = screen;
  if (!revealed) return <LookUp round={round} body="The map is on its way." />;
  return (
    <main className="sheet">
      <div className="waiting">
        <div className="waiting-main">
          <p className="kicker">{screen.place}</p>
          <h1 className="notice-title">{pinResultLine(result.km)}</h1>
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
