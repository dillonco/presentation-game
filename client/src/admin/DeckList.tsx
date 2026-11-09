import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deckContentSchema,
  emptyDeck,
  GAME_LABELS,
  type DeckSummary,
} from '../../../shared/deck.js';
import { APP_NAME } from '../appName.js';
import { api, ApiError, spaceFullMessage, startProblems, type RoomSummary } from './api.js';
import { ConfirmKey, Key } from './controls.js';

function describe(deck: DeckSummary): string {
  const parts = deck.games
    .filter((game) => game.count > 0)
    .map((game) => {
      const { name, item } = GAME_LABELS[game.type];
      return `${name}: ${game.count} ${game.count === 1 ? item : `${item}s`}`;
    });
  return parts.length > 0 ? parts.join(' · ') : 'Nothing added yet';
}

function fileNameFor(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'deck'}.presentation-game.json`;
}

function open(id: string): void {
  window.location.assign(`/admin/decks/${id}`);
}

export function DeckList({ onSignOut }: { onSignOut: () => void }) {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ deckId: string; items: string[] } | null>(null);
  const [space, setSpace] = useState<{ code: string; presenterKey: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setDecks(await api.decks());
      setRooms(await api.rooms());
      setSpace(await api.space());
    } catch {
      setDecks((current) => current ?? []);
      setMessage("Couldn't load your decks. Check the connection and refresh.");
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  const attempt = async (work: () => Promise<unknown>, failure: string) => {
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage(spaceFullMessage(error) ?? failure);
    }
  };

  const importFile = async (file: File) => {
    setMessage(null);
    try {
      const parsed = deckContentSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) throw new Error('Not a deck');
      open((await api.createDeck(parsed.data)).id);
    } catch {
      setMessage(`${file.name} isn't a deck this app can read.`);
    }
  };

  const exportDeck = async (id: string, title: string) => {
    const { content } = await api.deck(id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileNameFor(title);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <main className="desk">
      <header className="desk-head">
        <div>
          <p className="kicker">{APP_NAME}</p>
          <h1 className="deck-title">Your decks</h1>
        </div>
        <Key
          label="Sign out"
          onPress={async () => {
            // A hosted space has no password, so its presenter link is the only way back in.
            if (space && !window.confirm('Copy your presenter link first. Without it, you can\'t get back into this space.')) {
              return;
            }
            await api.signOut().catch(() => undefined);
            onSignOut();
          }}
        />
      </header>

      {space ? <SpaceDetails code={space.code} presenterKey={space.presenterKey} /> : null}

      <div className="desk-actions">
        <Key
          label="New deck"
          busyLabel="Creating…"
          tone="primary"
          onPress={() =>
            attempt(async () => open((await api.createDeck(emptyDeck())).id), "Couldn't create a deck. Try again.")
          }
        />
        <Key label="Import a deck" onPress={() => picker.current?.click()} />
        <Key
          label="Add the sample deck"
          busyLabel="Adding…"
          onPress={() =>
            attempt(async () => {
              await api.addSampleDeck();
              await refresh();
            }, "Couldn't add the sample deck. Try again.")
          }
        />
        <input
          ref={picker}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          aria-label="Deck file to import"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importFile(file);
          }}
        />
      </div>
      <p className="desk-message" role="alert">
        {message}
      </p>

      {decks && decks.length === 0 ? (
        <section className="desk-empty">
          <p>No decks yet. Start a new one, or add the sample deck to try all four games first.</p>
        </section>
      ) : null}

      {decks && decks.length > 0 ? (
        <ul className="deck-rows">
          {decks.map((deck) => (
            <li key={deck.id} className="deck-row">
              <div className="deck-row-main">
                <a className="deck-row-title" href={`/admin/decks/${deck.id}`}>
                  {deck.title || 'Untitled deck'}
                </a>
                <p className="desk-hint">{describe(deck)}</p>
              </div>
              <div className="deck-row-keys">
                <Key
                  label="Start game"
                  context={deck.title}
                  busyLabel="Starting…"
                  tone="primary"
                  onPress={async () => {
                    setProblems(null);
                    try {
                      window.location.assign(`/host/${await api.startGame(deck.id)}`);
                    } catch (error) {
                      setProblems({ deckId: deck.id, items: startProblems(error) });
                    }
                  }}
                />
                <Key
                  label="Duplicate"
                  context={deck.title}
                  onPress={() =>
                    attempt(async () => {
                      await api.duplicateDeck(deck.id);
                      await refresh();
                    }, "Couldn't duplicate that deck. Try again.")
                  }
                />
                <Key
                  label="Export"
                  context={deck.title}
                  onPress={() =>
                    attempt(() => exportDeck(deck.id, deck.title), "Couldn't export that deck. Try again.")
                  }
                />
                <ConfirmKey
                  label="Delete"
                  confirmLabel="Really delete?"
                  context={deck.title}
                  onConfirm={() =>
                    attempt(async () => {
                      await api.deleteDeck(deck.id);
                      await refresh();
                    }, "Couldn't delete that deck. Try again.")
                  }
                />
              </div>
              {problems?.deckId === deck.id ? (
                <div className="deck-problems" role="alert">
                  <p>This deck isn't ready to play yet:</p>
                  <ul>
                    {problems.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {rooms.length > 0 ? (
        <section className="desk-rooms" aria-label="Games">
          <h2 className="desk-section-title">Games</h2>
          <ul>
            {rooms.map((room) => (
              <li key={room.id} className="room-row">
                <a href={`/host/${room.id}`}>
                  {room.title} · {room.playerCount} {room.playerCount === 1 ? 'player' : 'players'}
                  {room.finished ? ' · Finished' : ''}
                </a>
                <ConfirmKey
                  label="Delete"
                  confirmLabel="Really delete?"
                  context={`${room.title} game`}
                  onConfirm={() =>
                    attempt(async () => {
                      // Already gone counts as done, say after deleting it from another tab.
                      await api.deleteRoom(room.id).catch((error: unknown) => {
                        if (!(error instanceof ApiError && error.status === 404)) throw error;
                      });
                      await refresh();
                    }, "Couldn't delete that game. Try again.")
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

/** A hosted space's join code and presenter link. */
function SpaceDetails({ code, presenterKey }: { code: string; presenterKey: string }) {
  const [copied, setCopied] = useState(false);
  // After the #, so the key never reaches the server's logs, a proxy, or another site's Referer.
  const link = `${window.location.origin}/p#${presenterKey}`;
  return (
    <section className="space-details" aria-label="Your space">
      <div>
        <h2 className="space-label">Join code</h2>
        <p className="space-code">{code}</p>
        <p className="desk-hint">
          Shown on the TV with the QR code. Guests can also type it at {window.location.host}.
        </p>
      </div>
      <div>
        <h2 className="space-label">Presenter link</h2>
        <p className="desk-hint">
          Open it on another device to present from there. Keep it private: it shows your answers.
        </p>
        <Key
          label={copied ? 'Copied' : 'Copy presenter link'}
          onPress={async () => {
            await navigator.clipboard.writeText(link).catch(() => window.prompt('Copy your presenter link:', link));
            setCopied(true);
          }}
        />
      </div>
    </section>
  );
}
