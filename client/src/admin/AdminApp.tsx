import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import '../theme/components.css';
import '../theme/phone.css';
import '../theme/admin.css';
import { ActionButton, useLockedAction } from '../ui/ActionButton.js';
import { DeckEditor } from './DeckEditor.js';
import { DeckList } from './DeckList.js';
import { PhoneShell } from '../ui/PhoneShell.js';
import { StatusArea, type StatusContent } from '../ui/StatusArea.js';
import { APP_NAME } from '../appName.js';
import { StartSpace } from '../Home.js';

/** Only ever returns to a presenter page, so a crafted link can't send you to another site. */
function safeNext(): string | null {
  const next = new URLSearchParams(window.location.search).get('next');
  return next && /^\/host\/[A-Za-z0-9_-]+$/.test(next) ? next : null;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<StatusContent>({ kind: 'empty' });
  const inputId = useId();
  const statusId = useId();

  const action = useLockedAction(async () => {
    if (!password) {
      setStatus({ kind: 'error', text: 'Enter the password.' });
      return;
    }
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (response.ok) {
        onSignedIn();
      } else if (response.status === 429) {
        setStatus({ kind: 'error', text: 'Too many tries. Wait a minute, then try again.' });
      } else {
        setStatus({ kind: 'error', text: "That password isn't right. Try again." });
      }
    } catch {
      setStatus({ kind: 'error', text: "Can't reach the server. Check the connection and try again." });
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
        Password
      </label>
      <input
        id={inputId}
        className="field-input"
        type="password"
        autoComplete="current-password"
        value={password}
        aria-invalid={status.kind === 'error' ? true : undefined}
        aria-describedby={statusId}
        onChange={(event) => {
          setPassword(event.target.value);
          setStatus({ kind: 'empty' });
        }}
      />
      <StatusArea id={statusId} content={status} />
      <ActionButton action={action} label="Sign in" busyLabel="Signing in…" />
    </form>
  );
}

const DECK_PATH = /^\/admin\/decks\/([A-Za-z0-9_-]{16})\/?$/;

export default function AdminApp() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [config, setConfig] = useState<{ hosted: boolean; passwordSignIn: boolean } | null>(null);

  useEffect(() => {
    void fetch('/api/config')
      .then((response) => response.json())
      .then(setConfig)
      .catch(() => setConfig({ hosted: false, passwordSignIn: true }));
  }, []);

  const refresh = useCallback(() => {
    void fetch('/api/admin/me')
      .then((response) => response.json())
      .then((data: { signedIn: boolean }) => {
        const next = safeNext();
        if (data.signedIn && next) window.location.replace(next);
        else setSignedIn(data.signedIn);
      })
      .catch(() => setSignedIn(false));
  }, []);

  useEffect(refresh, [refresh]);

  // The builder scrolls like a normal page. The sign-in screen stays fixed like the phones.
  useEffect(() => {
    if (signedIn) document.documentElement.dataset.page = 'desk';
    else delete document.documentElement.dataset.page;
  }, [signedIn]);

  if (signedIn === null || config === null) return null;
  if (signedIn) {
    const deckId = DECK_PATH.exec(window.location.pathname)?.[1];
    return deckId ? <DeckEditor deckId={deckId} /> : <DeckList onSignOut={() => setSignedIn(false)} />;
  }
  return (
    <PhoneShell>
      <main className="sheet">
        <header className="masthead">
          <p className="kicker">{APP_NAME}</p>
          <h1 className="deck-title">Presenter</h1>
        </header>
        {config.hosted ? (
          <>
            <p className="home-host-body">
              Make a space to build your decks. No account needed: this browser becomes its presenter. Already have
              one? Open your presenter link on this device.
            </p>
            <StartSpace />
            {config.passwordSignIn ? (
              <details className="server-sign-in">
                <summary>Run this server? Sign in with its password</summary>
                <SignIn onSignedIn={refresh} />
              </details>
            ) : null}
          </>
        ) : (
          <SignIn onSignedIn={refresh} />
        )}
      </main>
    </PhoneShell>
  );
}
