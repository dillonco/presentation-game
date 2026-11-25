import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type {
  CommandReply,
  GoneReason,
  HostCommand,
  HostHelloReply,
  HostPlayer,
  HostView,
} from '../../../shared/protocol.js';
import { usePreloadedMap } from '../map/lazy.js';
import { keepClockSynced } from '../net/clock.js';
import { openSocket, reconnectWithNetwork } from '../net/socket.js';
import { GAME_NAMES, GAME_NUMERALS, GAME_RULES } from '../theme/games.js';
import { gifFor, STANDINGS_GIFS, TITLE_GIFS } from '../theme/gifs.js';
import '../theme/components.css';
import '../theme/tv.css';
import { useAccent } from '../ui/accent.js';
import { useHeldUntil } from '../ui/reveal.js';
import { FinalView } from './FinalView.js';
import { GalleryView } from './GalleryView.js';
import { GifCard } from './GifCard.js';
import { QrCode } from './QrCode.js';
import { isMuted, setMuted as storeMuted, unlockSound } from './sound.js';
import { useSoundCues } from './useSoundCues.js';
import { PinRevealView } from './PinRevealView.js';
import { TipsView } from './TipsView.js';
import {
  GuessView,
  namesTier,
  PickRevealView,
  PickView,
  RevealView,
  ShowView,
  StandingsView,
  VoteView,
  WriteView,
} from './RoundViews.js';
import { moodFor, Scene } from './Scene.js';
import { APP_NAME } from '../appName.js';

const BAR_VISIBLE_MS = 3000;
const DOUBLE_PRESS_MS = 500;

type Connection = 'connecting' | 'online' | 'offline' | 'missing';

function useHostSession(room: string) {
  const [view, setView] = useState<HostView | null>(null);
  useAccent(view?.accent);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [offset, setOffset] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = openSocket(room, 'host');
    socketRef.current = socket;
    let lastVersion = 0;
    let active = true;

    socket.on('connect', () => {
      lastVersion = 0;
      setConnection('online');
      void socket
        .timeout(5000)
        .emitWithAck('host:hello', {})
        .then((reply: HostHelloReply) => {
          if (active && reply.ok) {
            lastVersion = reply.view.version;
            setView(reply.view);
          }
        })
        .catch(() => undefined);
    });
    let ended = false;
    socket.on('disconnect', (reason) => {
      setConnection((current) => (current === 'missing' ? current : 'offline'));
      // The server let go of this TV, for example after the presenter link was reset. Trying
      // again either gets back in with this browser's newer session, or goes to sign-in.
      if (reason === 'io server disconnect' && !ended) window.setTimeout(() => active && !ended && socket.connect(), 500);
    });
    // The presenter deleted this game, maybe from another screen.
    socket.on('kicked', (reason: GoneReason) => {
      if (reason === 'ended') {
        ended = true;
        setConnection('missing');
      }
    });
    socket.on('connect_error', (error) => {
      if (error.message === 'unauthorized') {
        window.location.assign(`/admin?next=${encodeURIComponent(window.location.pathname)}`);
      } else if (error.message === 'room_missing') {
        setConnection('missing');
      } else {
        setConnection('offline');
        if (!socket.active) window.setTimeout(() => active && socket.connect(), 1500);
      }
    });
    socket.on('view', (next: HostView) => {
      if (next.version < lastVersion) return;
      lastVersion = next.version;
      setView(next);
    });
    const stopWatching = reconnectWithNetwork(socket);
    const stopSyncing = keepClockSynced(socket, setOffset);

    return () => {
      active = false;
      stopWatching();
      stopSyncing();
      socket.close();
    };
  }, [room]);

  const send = useCallback(async (command: HostCommand): Promise<CommandReply | null> => {
    const socket = socketRef.current;
    if (!socket?.connected) return null;
    try {
      return (await socket.timeout(5000).emitWithAck('host:command', command)) as CommandReply;
    } catch {
      return null;
    }
  }, []);

  return { view, connection, offset, send };
}

function Lobby({ view, joinUrl }: { view: HostView; joinUrl: string }) {
  const full = view.players.length >= view.capacity;
  let instruction = 'Scan to join';
  let sub = 'Point your phone camera at the code.';
  if (view.joinLocked) {
    instruction = 'Joining is closed';
    sub = 'Already playing? Scan to get back in.';
  } else if (full) {
    instruction = 'The game is full';
    sub = 'Already playing? Scan to get back in.';
  }
  return (
    <>
      <header className="tv-header">
        <div>
          <p className="tv-kicker">{APP_NAME}</p>
          <h1 className={Array.from(view.title).length > 24 ? 'tv-title long' : 'tv-title'}>{view.title}</h1>
        </div>
        <p className="tv-count">
          <span className="sr-only">
            {view.players.length} of {view.capacity} joined
          </span>
          <span className="tv-count-now" aria-hidden="true">
            {String(view.players.length).padStart(2, '0')}
          </span>
          <span className="tv-count-sep" aria-hidden="true">
            /
          </span>
          <span className="tv-count-max" aria-hidden="true">
            {view.capacity}
          </span>
        </p>
      </header>
      <div className="lobby-body">
        <section className="lobby-join">
          <div className="qr-card">
            <QrCode text={joinUrl} label="QR code to join the game" />
          </div>
          <div className="lobby-caption">
            <p className="lobby-instruction">{instruction}</p>
            <p className="lobby-sub">{sub}</p>
          </div>
        </section>
        {view.players.length === 0 ? (
          <p className="names-empty">Names appear here as people join.</p>
        ) : (
          <ul className={`names ${namesTier(view.players.length)}`} aria-label="Players">
            {view.players.map((player) => (
              <li key={player.id} className={player.online ? undefined : 'offline'}>
                {player.name}
                {player.online ? null : <span className="sr-only"> (offline)</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function TitleCard({ view }: { view: HostView }) {
  if (view.screen.kind !== 'title') return null;
  const { game, gameNumber } = view.screen;
  return (
    <section className="title-card has-gif">
      <div className="title-text">
        <p className="title-numeral" aria-hidden="true">
          {GAME_NUMERALS[gameNumber - 1] ?? gameNumber}
        </p>
        <h1 className="title-name">{GAME_NAMES[game]}</h1>
        <p className="title-rule">{GAME_RULES[game]}</p>
      </div>
      <GifCard gif={gifFor(TITLE_GIFS, gameNumber)} className="title-gif" />
    </section>
  );
}

function PlayerPanel({
  players,
  onRemove,
  onClose,
}: {
  players: HostPlayer[];
  onRemove: (playerId: string) => void;
  onClose: () => void;
}) {
  // Two steps, because a removal blocks that phone and can't be undone.
  const [arming, setArming] = useState<string | null>(null);
  return (
    <aside className="tv-panel" aria-label="Player list">
      <div className="tv-panel-head">
        <h2>Players ({players.length})</h2>
        <button type="button" className="tv-key" onClick={onClose}>
          Close <kbd>R</kbd>
        </button>
      </div>
      <ul className="tv-panel-list">
        {players.map((player) => (
          <li key={player.id}>
            <span className="tv-panel-name">{player.name}</span>
            {player.online ? null : <span className="tv-panel-state">Offline</span>}
            {arming === player.id ? (
              <button type="button" className="tv-key danger" onClick={() => onRemove(player.id)}>
                Confirm removal
              </button>
            ) : (
              <button
                type="button"
                className="tv-key"
                aria-label={`Remove ${player.name}`}
                onClick={() => setArming(player.id)}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * The join QR code again, for after the lobby: a guest who closed the page scans it to get back in.
 * The same phone still holds its place and goes straight back. Another phone enters the same name,
 * and the TV asks the presenter.
 */
function RejoinCard({ joinUrl, onClose }: { joinUrl: string; onClose: () => void }) {
  return (
    <div className="tv-rejoin-scrim" onClick={onClose}>
      <aside className="tv-rejoin" aria-label="Rejoin link" onClick={(event) => event.stopPropagation()}>
        <div className="qr-card">
          <QrCode text={joinUrl} label="QR code to get back into the game" />
        </div>
        <div className="tv-rejoin-text">
          <h2 className="lobby-instruction">Scan to get back in</h2>
          <p className="lobby-sub">Same phone: you go straight back in.</p>
          <p className="lobby-sub">Another phone: enter the same name, and the presenter lets you in.</p>
          <button type="button" className="tv-key" onClick={onClose}>
            Close <kbd>J</kbd>
          </button>
        </div>
      </aside>
    </div>
  );
}

/**
 * Space shows the whole podium at once while it's still landing. Once it's up, Space moves on to
 * the tips, when the deck has some.
 */
function PodiumSkip({
  screen,
  offset,
  onSkip,
  next,
}: {
  screen: Extract<HostView['screen'], { kind: 'final' }>;
  offset: number;
  onSkip: () => void;
  next: boolean;
}) {
  const landing = !useHeldUntil(screen.shown ? 0 : screen.endsAt - offset);
  if (!landing) {
    return next ? (
      <button type="button" className="tv-key" onClick={onSkip}>
        Tips <kbd>Space</kbd>
      </button>
    ) : null;
  }
  return (
    <button type="button" className="tv-key" onClick={onSkip}>
      Show everyone <kbd>Space</kbd>
    </button>
  );
}

/** Fills the whole screen with the TV, hiding the browser's tabs and bars. Esc or F leaves it. */
function useFullScreen(): { supported: boolean; on: boolean; toggle: () => void } {
  const supported = typeof document !== 'undefined' && document.fullscreenEnabled === true;
  const [on, setOn] = useState(() => supported && document.fullscreenElement !== null);
  useEffect(() => {
    if (!supported) return;
    const update = () => setOn(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, [supported]);
  const toggle = useCallback(() => {
    if (!supported) return;
    // Refused when the press didn't come from the presenter, so there's nothing to do then.
    const change = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    void change.catch(() => undefined);
  }, [supported]);
  return { supported, on, toggle };
}

export default function HostApp({ room }: { room: string }) {
  const { view, connection, offset, send } = useHostSession(room);
  const fullScreen = useFullScreen();
  const [panelOpen, setPanelOpen] = useState(false);
  const [rejoinOpen, setRejoinOpen] = useState(false);
  const [barShown, setBarShown] = useState(false);
  const [muted, setMutedState] = useState(isMuted);
  useSoundCues(view, offset);
  // Counts presses of H. The word on screen plays its clip again on each one.
  const [replay, setReplay] = useState(0);

  const joinUrl = `${window.location.origin}/j/${room}`;

  const lastNextAt = useRef(Number.NEGATIVE_INFINITY);
  const lastTimeAt = useRef(Number.NEGATIVE_INFINITY);
  const screenChangedAt = useRef(Number.NEGATIVE_INFINITY);
  const screenId = view?.screenId;
  useEffect(() => {
    screenChangedAt.current = performance.now();
  }, [screenId]);

  const toggleMute = () => {
    storeMuted(!muted);
    setMutedState(!muted);
  };

  const next = () => {
    if (!view) return;
    // Naming the screen stops a double press that reaches the server before the TV updates.
    // On a fast connection the TV can update between presses, so a short pause covers that too.
    const now = performance.now();
    if (now - lastNextAt.current < DOUBLE_PRESS_MS) return;
    lastNextAt.current = now;
    void send({ type: 'next', screenId: view.screenId });
  };

  const skipTimer = () => {
    if (!view) return;
    // A doubled S ends the writing, and mustn't also throw away the answers that just came up.
    if (view.screen.kind === 'show' && performance.now() - screenChangedAt.current < DOUBLE_PRESS_MS) return;
    void send({ type: 'skipTimer', screenId: view.screenId });
  };

  /** A held or doubled key shouldn't add 30 seconds. */
  const addTime = () => {
    const now = performance.now();
    if (!view || now - lastTimeAt.current < DOUBLE_PRESS_MS) return;
    lastTimeAt.current = now;
    void send({ type: 'addTime', screenId: view.screenId });
  };

  const togglePause = () => {
    const screen = view?.screen;
    if (
      screen?.kind === 'write' ||
      screen?.kind === 'show' ||
      screen?.kind === 'vote' ||
      screen?.kind === 'guess' ||
      screen?.kind === 'pick'
    ) {
      void send({ type: 'setPaused', paused: screen.timer.pausedRemainingMs === null });
    }
  };

  const replayClip = () => {
    if (view?.screen.kind === 'write' && view.screen.round.clip) setReplay((count) => count + 1);
  };

  const hideEntry = (entryId: string) => void send({ type: 'hideEntry', entryId });

  const toggleLock = () => {
    if (view) void send({ type: 'setJoinLocked', locked: !view.joinLocked });
  };

  const answerRejoin = (requestId: string, approve: boolean) => void send({ type: 'answerRejoin', requestId, approve });

  const onKeyDown = (event: KeyboardEvent) => {
    unlockSound();
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === ' ') {
      event.preventDefault();
      // Stops Space also clicking whichever on-screen button has focus.
      (document.activeElement as HTMLElement | null)?.blur?.();
      next();
    } else if (key === 's') {
      skipTimer();
    } else if (key === '+' || key === '=') {
      addTime();
    } else if (key === 'p') {
      togglePause();
    } else if (key === 'l') {
      toggleLock();
    } else if (key === 'r') {
      setPanelOpen((open) => !open);
    } else if (key === 'j') {
      // The lobby already shows the code.
      if (view?.screen.kind !== 'lobby') setRejoinOpen((open) => !open);
    } else if (key === 'escape') {
      setPanelOpen(false);
      setRejoinOpen(false);
    } else if (key === 'm') {
      toggleMute();
    } else if ((key === 'y' || key === 'n') && view?.rejoinRequests[0]) {
      answerRejoin(view.rejoinRequests[0].id, key === 'y');
    } else if (key === 'h') {
      replayClip();
    } else if (key === 'f') {
      fullScreen.toggle();
    }
  };
  // One listener for the page's life, which always runs this render's handler.
  const keyHandler = useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  useEffect(() => {
    window.addEventListener('pointerdown', unlockSound);
    return () => window.removeEventListener('pointerdown', unlockSound);
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const onMove = () => {
      setBarShown(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setBarShown(false), BAR_VISIBLE_MS);
    };
    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.clearTimeout(timer);
    };
  }, []);

  // Fetched during the game before it, so the reveal never waits on the map.
  usePreloadedMap(view?.mapArea?.name, () => import('../map/RevealMap.js'));

  if (connection === 'missing') {
    return (
      <main className="tv" data-mood="night">
        <Scene mood="night" />
        <section className="title-card">
          <h1 className="title-name">This game isn't running</h1>
          <p className="title-rule">Start a new game from the admin page.</p>
        </section>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="tv" data-mood="night">
        <Scene mood="night" />
        <section className="title-card">
          <p className="title-rule">Connecting…</p>
        </section>
      </main>
    );
  }

  const mood = moodFor(view.screen.kind);
  return (
    <main className="tv" data-mood={mood} data-screen={view.screen.kind}>
      <Scene mood={mood} />
      {view.screen.kind === 'lobby' ? <Lobby view={view} joinUrl={joinUrl} /> : null}
      {view.screen.kind === 'title' ? <TitleCard view={view} /> : null}
      {view.screen.kind === 'write' ? (
        <WriteView screen={view.screen} players={view.players} offset={offset} replay={replay} muted={muted} />
      ) : null}
      {view.screen.kind === 'show' ? <ShowView screen={view.screen} onHide={hideEntry} /> : null}
      {view.screen.kind === 'vote' ? (
        <VoteView screen={view.screen} players={view.players} offset={offset} onHide={hideEntry} />
      ) : null}
      {view.screen.kind === 'reveal' ? <RevealView screen={view.screen} offset={offset} onHide={hideEntry} /> : null}
      {view.screen.kind === 'guess' ? <GuessView screen={view.screen} players={view.players} offset={offset} /> : null}
      {view.screen.kind === 'pinReveal' ? (
        <PinRevealView screen={view.screen} area={view.mapArea!} offset={offset} />
      ) : null}
      {view.screen.kind === 'pick' ? <PickView screen={view.screen} players={view.players} offset={offset} /> : null}
      {view.screen.kind === 'pickReveal' ? <PickRevealView screen={view.screen} offset={offset} /> : null}
      {view.screen.kind === 'gallery' ? <GalleryView screen={view.screen} /> : null}
      {view.screen.kind === 'standings' ? (
        <StandingsView
          heading="Standings"
          sub={`After ${GAME_NAMES[view.screen.game]}`}
          rows={view.screen.rows}
          playerCount={view.screen.playerCount}
          gif={gifFor(STANDINGS_GIFS, view.screen.gameNumber)}
        />
      ) : null}
      {view.screen.kind === 'final' ? <FinalView screen={view.screen} title={view.title} offset={offset} /> : null}
      {view.screen.kind === 'tips' ? <TipsView screen={view.screen} title={view.title} /> : null}

      {connection === 'offline' ? (
        <p className="tv-offline" role="status">
          Reconnecting…
        </p>
      ) : null}

      {view.rejoinRequests.length > 0 ? (
        <div className="tv-prompts">
          {view.rejoinRequests.map((request, index) => (
            <p key={request.id} className="tv-prompt">
              <span>{request.name} wants back in</span>
              <button
                type="button"
                className="tv-key"
                onClick={() => answerRejoin(request.id, true)}
              >
                Allow {index === 0 ? <kbd>Y</kbd> : null}
              </button>
              <button
                type="button"
                className="tv-key"
                onClick={() => answerRejoin(request.id, false)}
              >
                Decline {index === 0 ? <kbd>N</kbd> : null}
              </button>
            </p>
          ))}
        </div>
      ) : null}

      {rejoinOpen && view.screen.kind !== 'lobby' ? (
        <RejoinCard joinUrl={joinUrl} onClose={() => setRejoinOpen(false)} />
      ) : null}

      {panelOpen ? (
        <PlayerPanel
          players={view.players}
          onRemove={(playerId) => void send({ type: 'remove', playerId })}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}

      <nav className={barShown ? 'tv-bar shown' : 'tv-bar'} aria-label="Presenter controls">
        {view.screen.kind === 'final' || view.screen.kind === 'tips' ? (
          <>
            {view.screen.kind === 'final' ? (
              <PodiumSkip screen={view.screen} offset={offset} onSkip={next} next={view.canAdvance} />
            ) : null}
            <a className="tv-key" href="/admin">
              Your decks
            </a>
          </>
        ) : (
          <button type="button" className="tv-key" onClick={next} disabled={!view.canAdvance}>
            {view.screen.kind === 'show' ? 'Next answer' : 'Next'} <kbd>Space</kbd>
          </button>
        )}
        {view.screen.kind === 'show' ? (
          <>
            <button type="button" className="tv-key" onClick={skipTimer}>
              Skip to voting <kbd>S</kbd>
            </button>
            <button type="button" className="tv-key" onClick={togglePause}>
              {view.screen.timer.pausedRemainingMs === null ? 'Hold this one' : 'Carry on'} <kbd>P</kbd>
            </button>
          </>
        ) : null}
        {view.screen.kind === 'write' ||
        view.screen.kind === 'vote' ||
        view.screen.kind === 'guess' ||
        view.screen.kind === 'pick' ? (
          <>
            <button type="button" className="tv-key" onClick={skipTimer}>
              Skip timer <kbd>S</kbd>
            </button>
            <button type="button" className="tv-key" onClick={addTime}>
              Add 15 seconds <kbd>+</kbd>
            </button>
            <button type="button" className="tv-key" onClick={togglePause}>
              {view.screen.timer.pausedRemainingMs === null ? 'Pause' : 'Resume'} <kbd>P</kbd>
            </button>
            {view.screen.kind === 'write' && view.screen.round.clip ? (
              <button type="button" className="tv-key" onClick={replayClip}>
                Hear it again <kbd>H</kbd>
              </button>
            ) : null}
          </>
        ) : null}
        <button type="button" className="tv-key" onClick={toggleLock}>
          {view.joinLocked ? 'Open joining' : 'Close joining'} <kbd>L</kbd>
        </button>
        <button type="button" className="tv-key" onClick={() => setPanelOpen((open) => !open)}>
          Players <kbd>R</kbd>
        </button>
        {view.screen.kind !== 'lobby' ? (
          <button type="button" className="tv-key" aria-pressed={rejoinOpen} onClick={() => setRejoinOpen((open) => !open)}>
            Rejoin link <kbd>J</kbd>
          </button>
        ) : null}
        <button type="button" className="tv-key" aria-pressed={muted} onClick={toggleMute}>
          {muted ? 'Unmute' : 'Mute'} <kbd>M</kbd>
        </button>
        {fullScreen.supported ? (
          <button type="button" className="tv-key" aria-pressed={fullScreen.on} onClick={fullScreen.toggle}>
            {fullScreen.on ? 'Exit full screen' : 'Full screen'} <kbd>F</kbd>
          </button>
        ) : null}
      </nav>
    </main>
  );
}
