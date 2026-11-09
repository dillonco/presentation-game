import { lazy, Suspense, useEffect, useState } from 'react';
import type { Country } from '../../../shared/countries.js';
import type { HostScreen } from '../../../shared/protocol.js';
import { PIN_REVEAL, pinNameTimes } from '../../../shared/reveal.js';
import { OutlineMap, type MapMark } from '../map/OutlineMap.js';
import { useOutline } from '../map/useOutline.js';
import { formatKm, GAME_NAMES, roundPosition } from '../theme/games.js';
import { TvPhoto } from '../ui/Photo.js';

type RevealMapProps = Parameters<typeof import('../map/RevealMap.js').default>[0];

/** If the map engine can't arrive, it says so and the view falls back to the outline. */
const RevealMap = lazy(() =>
  import('../map/RevealMap.js').catch(() => ({
    default: ({ onFail }: RevealMapProps) => {
      useEffect(onFail, [onFail]);
      return <></>;
    },
  })),
);

/** Time since the reveal began. Passes the end straight away once Space has skipped ahead. */
function useElapsed(startedAt: number, endsAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Date.now() >= endsAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  const current = Math.max(now, Date.now());
  return current >= endsAt ? Number.POSITIVE_INFINITY : current - startedAt;
}

export function PinRevealView({
  screen,
  area,
  offset,
}: {
  screen: Extract<HostScreen, { kind: 'pinReveal' }>;
  area: Country;
  offset: number;
}) {
  const startedAt = screen.startedAt - offset;
  const endsAt = screen.endsAt - offset;
  const elapsed = useElapsed(startedAt, endsAt);
  const { outline, settled } = useOutline(area.name);
  const [noEngine, setNoEngine] = useState(false);
  const { round, target, pins } = screen;

  const targetShown = elapsed >= PIN_REVEAL.flyAtMs;
  const times = pinNameTimes(pins.length);
  const rows = pins.slice(0, PIN_REVEAL.rows);
  const marks: MapMark[] = [
    ...pins.map((pin): MapMark => ({ lat: pin.lat, lng: pin.lng, kind: 'pin' })),
    ...(targetShown ? [{ lat: target.lat, lng: target.lng, kind: 'target' } as const] : []),
  ];
  const fallback = (
    <div className="map-fallback">
      <OutlineMap area={area} outline={outline} marks={marks} />
    </div>
  );

  return (
    <>
      <header className="tv-round-head">
        <p className="tv-round-line">
          {GAME_NAMES[round.game]} · {roundPosition(round)}
        </p>
      </header>
      <div className="tv-map-stage">
        <section className="tv-map" aria-label={`Map of ${area.name}`}>
          {noEngine || !settled ? (
            fallback
          ) : (
            <Suspense fallback={fallback}>
              <RevealMap
                area={area}
                outline={outline}
                target={target}
                pins={pins}
                startedAt={startedAt}
                endsAt={endsAt}
                onFail={() => setNoEngine(true)}
              />
            </Suspense>
          )}
        </section>
        <aside className="tv-map-side">
          <TvPhoto image={round.image!} alt={roundPosition(round)} />
          <h1 className="tv-map-place">{targetShown ? target.label : 'Where was this?'}</h1>
          {pins.length === 0 ? (
            <p className="tv-word-rule">No pins this time.</p>
          ) : (
            <ol className="pin-rows">
              {rows.map((pin, index) => {
                const arrived = elapsed >= times[index]!;
                return (
                  <li key={pin.id} className={arrived ? 'pin-row in' : 'pin-row'} aria-hidden={!arrived}>
                    <span className="pin-row-rank">{index + 1}</span>
                    <span className="pin-row-who">
                      <bdi className="pin-row-name">{pin.name}</bdi>
                      <span className="pin-row-km">{formatKm(pin.km)}</span>
                    </span>
                    <span className="pin-row-points">+{pin.points}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {pins.length > rows.length && elapsed >= PIN_REVEAL.namesAtMs ? (
            <p className="pin-rows-more">
              {pins.length - rows.length} more {pins.length - rows.length === 1 ? 'pin' : 'pins'} on the map
            </p>
          ) : null}
        </aside>
      </div>
    </>
  );
}
