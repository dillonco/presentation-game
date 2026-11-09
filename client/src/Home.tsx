import { useEffect, useId, useState, type FormEvent } from 'react';
import './theme/components.css';
import './theme/phone.css';
import { APP_NAME } from './appName.js';
import { ActionButton, useLockedAction } from './ui/ActionButton.js';
import { PhoneShell } from './ui/PhoneShell.js';
import { StatusArea, type StatusContent } from './ui/StatusArea.js';


interface Config {
  hosted: boolean;
}

/** The front page. On a hosted server, guests type the code from the TV and presenters make a space. */
export default function Home() {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    void fetch('/api/config')
      .then((response) => response.json() as Promise<Config>)
      .then(setConfig)
      .catch(() => setConfig({ hosted: false }));
  }, []);

  if (!config) return null;
  return (
    <PhoneShell>
      <main className="sheet">
        <header className="masthead">
          <p className="kicker">{APP_NAME}</p>
          <h1 className="deck-title">{config.hosted ? 'Join a game' : 'Scan the code on the TV to join'}</h1>
        </header>
        {config.hosted ? (
          <>
            <JoinByCode />
            <section className="home-host">
              <h2 className="home-host-title">Presenting?</h2>
              <p className="home-host-body">
                Make your own space to build a deck from your photos and words. No account needed.
              </p>
              <StartSpace />
            </section>
          </>
        ) : (
          <p className="home-host-body">
            Presenting? <a href="/admin">Sign in</a> to build a deck and start a game.
          </p>
        )}
      </main>
    </PhoneShell>
  );
}

function JoinByCode() {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<StatusContent>({ kind: 'empty' });
  const inputId = useId();
  const statusId = useId();

  const action = useLockedAction(async () => {
    const typed = code.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z]{6}$/.test(typed)) {
      setStatus({ kind: 'error', text: 'Enter the 6 letters shown on the TV.' });
      return;
    }
    try {
      const response = await fetch(`/api/join/${typed}`);
      const body = (await response.json().catch(() => ({}))) as { room?: string; error?: string };
      if (response.ok && body.room) {
        window.location.assign(`/j/${body.room}`);
      } else if (response.status === 429) {
        setStatus({ kind: 'error', text: 'Too many tries. Wait a moment, then try again.' });
      } else if (body.error === 'no_game') {
        setStatus({ kind: 'error', text: "That game hasn't started yet. Try again once it's on the TV." });
      } else {
        setStatus({ kind: 'error', text: "No game has that code. Check the letters on the TV." });
      }
    } catch {
      setStatus({ kind: 'error', text: "Can't reach the game. Check your connection and try again." });
    }
  });

  return (
    <form
      className="join-form"
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        action.run();
      }}
    >
      <label className="field-label" htmlFor={inputId}>
        Code from the TV
      </label>
      <input
        id={inputId}
        className="field-input code-input"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        maxLength={8}
        value={code}
        aria-invalid={status.kind === 'error' ? true : undefined}
        aria-describedby={statusId}
        onChange={(event) => {
          setCode(event.target.value);
          setStatus({ kind: 'empty' });
        }}
      />
      <StatusArea id={statusId} content={status} />
      <ActionButton action={action} label="Join" busyLabel="Finding the game…" />
    </form>
  );
}

export function StartSpace() {
  const [status, setStatus] = useState<StatusContent>({ kind: 'empty' });
  const statusId = useId();
  const action = useLockedAction(async () => {
    try {
      const response = await fetch('/api/spaces', { method: 'POST' });
      if (response.ok) window.location.assign('/admin');
      else if (response.status === 429) setStatus({ kind: 'error', text: 'Lots of people are starting at once. Try again in a minute.' });
      else setStatus({ kind: 'error', text: "Couldn't make your space. Try again." });
    } catch {
      setStatus({ kind: 'error', text: "Can't reach the server. Check your connection and try again." });
    }
  });
  return (
    <div>
      <StatusArea id={statusId} content={status} />
      <ActionButton action={action} label="Make my space" busyLabel="Making it…" />
    </div>
  );
}

/**
 * A presenter link: makes this device the presenter of that space, then opens its decks. It waits
 * for a press, so a link someone else sent can't quietly swap this browser into their space, where
 * they'd see whatever gets added.
 */
export function ClaimSpace({ presenterKey }: { presenterKey: string }) {
  const [status, setStatus] = useState<StatusContent>({ kind: 'empty' });
  const statusId = useId();
  const action = useLockedAction(async () => {
    try {
      const response = await fetch('/api/spaces/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: presenterKey }),
      });
      if (response.ok) window.location.replace('/admin');
      else setStatus({ kind: 'error', text: "That presenter link doesn't work. Check you copied all of it." });
    } catch {
      setStatus({ kind: 'error', text: "Can't reach the server. Check your connection and try again." });
    }
  });

  return (
    <PhoneShell>
      <main className="sheet">
        <div className="notice">
          <h1 className="notice-title">Present from this device?</h1>
          <p className="notice-body">
            This opens a space's decks here. Only go on if the link is yours or from someone you present with: they
            can see everything added to it.
          </p>
        </div>
        <StatusArea id={statusId} content={status} />
        <ActionButton action={action} label="Open the space" busyLabel="Opening…" />
      </main>
    </PhoneShell>
  );
}
