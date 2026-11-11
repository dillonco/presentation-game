import { useEffect, useMemo, useRef, useState } from 'react';
import { accentIsReadable } from '../../../shared/color.js';
import { COUNTRIES } from '../../../shared/countries.js';
import {
  deckProblems,
  emptyGame,
  GAME_LABELS,
  MAX_BLOCKED_WORD,
  MAX_BLOCKED_WORDS,
  MAX_DECK_TITLE,
  MAX_GAMES,
  type DeckContent,
  type DeckGame,
  type StoredDeck,
} from '../../../shared/deck.js';
import { ActionButton, useLockedAction } from '../ui/ActionButton.js';
import { api, ApiError, startProblems } from './api.js';
import { Field, Key } from './controls.js';
import { CaptionEditor, ChoiceEditor, DefineEditor, GeoEditor, usePhotoUploads } from './GameEditors.js';
import { TipsEditor } from './TipsEditor.js';
import { useAutosave, type SaveStatus } from './useAutosave.js';

const DEFAULT_ACCENT = '#a8452f';

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  retrying: 'Not saved yet. Trying again…',
  signed_out: 'Your sign-in ran out, so this isn’t saved.',
  conflict: 'This deck changed in another tab, so this copy can’t be saved.',
  refused: 'The server refused this version. Undo your last change.',
};

function SaveLine({ status }: { status: SaveStatus }) {
  return (
    <p className={status === 'saved' || status === 'saving' ? 'save-line' : 'save-line wrong'} role="status">
      {STATUS_TEXT[status]}
      {status === 'signed_out' ? (
        <>
          {' '}
          <a href="/admin" target="_blank" rel="noopener">
            Sign in again
          </a>
          , and it’ll save by itself.
        </>
      ) : null}
      {status === 'conflict' ? (
        <>
          {' '}
          <a href={window.location.pathname}>Reload the latest</a>
        </>
      ) : null}
    </p>
  );
}

function Editor({ loaded }: { loaded: StoredDeck }) {
  const [content, setContent] = useState<DeckContent>(loaded.content);
  const [blockedText, setBlockedText] = useState(loaded.content.moderation.blocklist.join(', '));
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [showProblems, setShowProblems] = useState(false);
  const { status, flush } = useAutosave(loaded.id, loaded.revision, content);
  const { uploads, lines, errors } = usePhotoUploads();
  const problemsBox = useRef<HTMLDivElement>(null);

  const problems = useMemo(() => [...deckProblems(content), ...serverProblems], [content, serverProblems]);

  const change = (update: Partial<DeckContent>) => {
    setServerProblems([]);
    setContent((current) => ({ ...current, ...update }));
  };

  /** Finds the game by position, which stays fixed because games can't move during an upload. */
  const updateGame = <G extends DeckGame>(index: number, update: (game: G) => G) => {
    setServerProblems([]);
    setContent((current) => ({
      ...current,
      games: current.games.map((game, position) => (position === index ? update(game as G) : game)),
    }));
  };

  const moveGame = (from: number, to: number) => {
    const games = [...content.games];
    games.splice(to, 0, games.splice(from, 1)[0]!);
    change({ games });
  };

  const start = useLockedAction(async () => {
    setServerProblems([]);
    if (deckProblems(content).length > 0) {
      setShowProblems(true);
      problemsBox.current?.scrollIntoView({ block: 'center' });
      return;
    }
    if (uploads.running > 0) {
      setServerProblems(['Wait for the photos to finish uploading.']);
      setShowProblems(true);
      return;
    }
    if (!(await flush())) {
      setServerProblems(["This deck isn't saved yet. Check the connection and try again."]);
      setShowProblems(true);
      return;
    }
    try {
      window.location.assign(`/host/${await api.startGame(loaded.id)}`);
    } catch (error) {
      setServerProblems(startProblems(error));
      setShowProblems(true);
    }
  });

  const accent = content.theme.accent;

  return (
    <>
    <header className="editor-bar">
      <div className="editor-bar-inner">
        <a className="back-link" href="/admin">
          ← Your decks
        </a>
        <SaveLine status={status} />
        <div className="editor-start">
          <ActionButton action={start} label="Start game" busyLabel="Starting…" />
        </div>
      </div>
    </header>
    <main className="desk">
      <p className="spoiler-note">Real answers are visible on this page. Keep it off the TV.</p>

      <section className="desk-section" aria-labelledby="deck-details">
        <h1 className="desk-section-title" id="deck-details">
          Deck
        </h1>
        <div className="detail-grid">
          <Field label="Title">
            {(id) => (
              <input
                id={id}
                className="field-input"
                maxLength={MAX_DECK_TITLE}
                value={content.title}
                onChange={(event) => change({ title: event.target.value })}
              />
            )}
          </Field>
          <Field label="Country for the map">
            {(id) => (
              <select
                id={id}
                className="field-input"
                value={content.region.country}
                onChange={(event) => change({ region: { country: event.target.value } })}
              >
                {COUNTRIES.map((country) => (
                  <option key={country.name} value={country.name}>
                    {country.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <details className="timing">
          <summary>Colour and moderation</summary>
          <div className="detail-grid">
            <Field
              label="Accent colour"
              hint={
                accent && !accentIsReadable(accent) ? (
                  <span className="desk-error">Too pale to read on paper. Choose a darker colour.</span>
                ) : (
                  'Used for the seal and the real answer.'
                )
              }
            >
              {(id) => (
                <span className="accent-row">
                  <input
                    id={id}
                    className="accent-input"
                    type="color"
                    value={accent ?? DEFAULT_ACCENT}
                    onChange={(event) => change({ theme: { accent: event.target.value } })}
                  />
                  <Key
                    label="Use the default"
                    disabled={accent === null}
                    onPress={() => change({ theme: { accent: null } })}
                  />
                </span>
              )}
            </Field>
            <Field label="How close counts as too similar">
              {(id) => (
                <select
                  id={id}
                  className="field-input"
                  value={content.moderation.similarity}
                  onChange={(event) =>
                    change({
                      moderation: {
                        ...content.moderation,
                        similarity: event.target.value as DeckContent['moderation']['similarity'],
                      },
                    })
                  }
                >
                  <option value="loose">Loose: only near-copies</option>
                  <option value="normal">Normal</option>
                  <option value="strict">Strict: catches more rewording</option>
                </select>
              )}
            </Field>
            <Field label="Words to refuse" hint="Separate them with commas. Applies to names and answers.">
              {(id) => (
                <textarea
                  id={id}
                  className="field-input"
                  rows={2}
                  value={blockedText}
                  onChange={(event) => {
                    setBlockedText(event.target.value);
                    change({
                      moderation: {
                        ...content.moderation,
                        blocklist: event.target.value
                          .split(/[,\n]/)
                          .map((word) => word.trim().slice(0, MAX_BLOCKED_WORD))
                          .filter(Boolean)
                          .slice(0, MAX_BLOCKED_WORDS),
                      },
                    });
                  }}
                />
              )}
            </Field>
            <label className="check-row">
              <input
                type="checkbox"
                checked={content.moderation.showLeftPage}
                onChange={(event) =>
                  change({ moderation: { ...content.moderation, showLeftPage: event.target.checked } })
                }
              />
              <span>Show 👀 on the TV when a guest leaves the page during a round</span>
            </label>
          </div>
        </details>
      </section>

      {content.games.map((game, index) => {
        const heading = `deck-game-${index}`;
        const { name } = GAME_LABELS[game.type];
        return (
          <section key={index} className="desk-section" aria-labelledby={heading}>
            <div className="game-head">
              <h2 className="desk-section-title" id={heading}>
                <span className="game-number">{index + 1}</span> {name}
              </h2>
              <div className="row-keys">
                <Key
                  label="↑"
                  context={`Move ${name} earlier`}
                  disabled={index === 0 || uploads.running > 0}
                  onPress={() => moveGame(index, index - 1)}
                />
                <Key
                  label="↓"
                  context={`Move ${name} later`}
                  disabled={index === content.games.length - 1 || uploads.running > 0}
                  onPress={() => moveGame(index, index + 1)}
                />
                <Key
                  label="Remove"
                  context={name}
                  disabled={uploads.running > 0}
                  onPress={() => change({ games: content.games.filter((_, position) => position !== index) })}
                />
              </div>
            </div>
            {game.type === 'define' ? (
              <DefineEditor game={game} onChange={(next) => updateGame(index, () => next)} />
            ) : null}
            {game.type === 'geo' ? (
              <GeoEditor
                game={game}
                country={content.region.country}
                uploads={uploads}
                onChange={(update) => updateGame(index, update)}
              />
            ) : null}
            {game.type === 'caption' ? (
              <CaptionEditor game={game} uploads={uploads} onChange={(update) => updateGame(index, update)} />
            ) : null}
            {game.type === 'choice' ? (
              <ChoiceEditor game={game} uploads={uploads} onChange={(update) => updateGame(index, update)} />
            ) : null}
          </section>
        );
      })}

      <div className="upload-lines" role="status">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {errors.length > 0 ? (
        <div className="deck-problems" role="alert">
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="desk-section" aria-label="Add a game">
        <h2 className="desk-section-title">Add a game</h2>
        <div className="desk-actions">
          {(['define', 'geo', 'caption', 'choice'] as const).map((type) => (
            <Key
              key={type}
              label={GAME_LABELS[type].name}
              context="Add"
              disabled={content.games.length >= MAX_GAMES}
              onPress={() => change({ games: [...content.games, emptyGame(type)] })}
            />
          ))}
        </div>
      </section>

      <section className="desk-section" aria-labelledby="deck-tips">
        <h2 className="desk-section-title" id="deck-tips">
          Tips
        </h2>
        <TipsEditor
          tips={content.tips ?? []}
          uploads={uploads}
          onChange={(update) => {
            setServerProblems([]);
            setContent((current) => ({ ...current, tips: update(current.tips ?? []) }));
          }}
        />
      </section>

      <div ref={problemsBox} className="desk-section" aria-live="polite">
        {problems.length === 0 ? (
          <p className="ready-line">Ready to play.</p>
        ) : (
          <div className={showProblems ? 'deck-problems pressed' : 'deck-problems'}>
            <p>Before you can start:</p>
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
    </>
  );
}

export function DeckEditor({ deckId }: { deckId: string }) {
  const [deck, setDeck] = useState<StoredDeck | null>(null);
  const [failure, setFailure] = useState<'missing' | 'offline' | null>(null);

  useEffect(() => {
    let active = true;
    api
      .deck(deckId)
      .then((loaded) => {
        if (active) setDeck(loaded);
      })
      .catch((error: unknown) => {
        if (active) setFailure(error instanceof ApiError && error.status === 404 ? 'missing' : 'offline');
      });
    return () => {
      active = false;
    };
  }, [deckId]);

  if (failure) {
    return (
      <main className="desk">
        <h1 className="deck-title">{failure === 'missing' ? "This deck doesn't exist" : "Couldn't load this deck"}</h1>
        <p className="desk-message">
          <a href="/admin">Back to your decks</a>
        </p>
      </main>
    );
  }
  return deck ? <Editor loaded={deck} /> : null;
}
