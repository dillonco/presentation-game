import { lazy, Suspense, useEffect, useId, useState, type DragEvent } from 'react';
import { MAX_ANSWER_LENGTH } from '../../../shared/constants.js';
import { findCountry, insideCountry } from '../../../shared/countries.js';
import {
  choiceLetter,
  clipIsEmpty,
  clipProblem,
  clipToPlay,
  emptyChoice,
  isVideoId,
  MAX_CHOICE,
  MAX_EXTRA_PHOTOS,
  MAX_ITEMS_PER_GAME,
  MAX_LINK,
  MAX_PLACE_LABEL,
  MAX_POINTS,
  MAX_QUESTION,
  MAX_SECONDS,
  MAX_WORD,
  MIN_SECONDS,
  MAX_SHOW_SECONDS,
  MAX_VIDEO_MB,
  MIN_SHOW_SECONDS,
  type CaptionGame,
  type ChoiceGame,
  type DeckClip,
  type DefineGame,
  type DeckGame,
  type GeoGame,
} from '../../../shared/deck.js';
import {
  DEFAULT_CLIP_SECONDS,
  formatClipTime,
  MAX_CLIP_SECONDS,
  parseClipTime,
  parseYouTubeLink,
  roundClipTime,
} from '../../../shared/youtube.js';
import { YouTubeClip, type ClipState } from '../ui/YouTubeClip.js';
import { ApiError, spaceFullMessage } from './api.js';
import { Field, Key, NumberField } from './controls.js';
import { addMedia, isVideoFile, VideoError, type AddedPhoto } from './photos.js';

const LocationPicker = lazy(() => import('./LocationPicker.js'));

const COUNT_FROM = 120;

/** A photo, or a video's poster with a label saying it will play on the TV. */
function MediaThumb({ id, alt }: { id: string; alt: string }) {
  const image = <img className="photo-thumb" src={`/media/${id}/small.jpg`} alt={alt} loading="lazy" />;
  if (!isVideoId(id)) return image;
  return (
    <span className="media-thumb">
      {image}
      <span className="media-badge" aria-hidden="true">
        Video
      </span>
    </span>
  );
}

export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  next.splice(to, 0, next.splice(from, 1)[0]!);
  return next;
}

function Timing<G extends DeckGame>({ game, onChange, fields }: {
  game: G;
  onChange: (game: G) => void;
  fields: { key: string; label: string; placeholder: number; seconds?: boolean; min?: number; max?: number }[];
}) {
  const settings = game.settings as Record<string, number | undefined>;
  return (
    <details className="timing">
      <summary>Timers and points</summary>
      <div className="timing-grid">
        {fields.map((field) => (
          <NumberField
            key={field.key}
            label={field.label}
            value={settings[field.key]}
            placeholder={field.placeholder}
            min={field.min ?? (field.seconds ? MIN_SECONDS : 0)}
            max={field.max ?? (field.seconds ? MAX_SECONDS : MAX_POINTS)}
            onChange={(value) => onChange({ ...game, settings: { ...settings, [field.key]: value } } as G)}
          />
        ))}
      </div>
    </details>
  );
}

export function RowKeys({ name, index, count, locked, onMove, onRemove }: {
  name: string;
  index: number;
  count: number;
  locked: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="row-keys">
      <Key label="↑" context={`Move ${name} up`} disabled={locked || index === 0} onPress={() => onMove(index - 1)} />
      <Key
        label="↓"
        context={`Move ${name} down`}
        disabled={locked || index === count - 1}
        onPress={() => onMove(index + 1)}
      />
      <Key label="Remove" context={name} disabled={locked} onPress={onRemove} />
    </div>
  );
}

/** A clip time typed as it reads in YouTube's player. Anything unreadable snaps back when you leave the box. */
function TimeField({ label, value, placeholder, onChange }: {
  label: string;
  value: number | null;
  placeholder: string;
  onChange: (value: number | null) => void;
}) {
  const shown = value === null ? '' : formatClipTime(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  return (
    <Field label={label}>
      {(id) => (
        <input
          id={id}
          className="field-input clip-time"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            if (text.trim() === '') return onChange(null);
            const seconds = parseClipTime(text);
            if (seconds !== null) onChange(seconds);
          }}
          onBlur={() => setDraft(shown)}
        />
      )}
    </Field>
  );
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Someone saying the word, from part of a YouTube video, which the TV plays as the word goes up. */
function ClipEditor({ clip, number, onChange }: {
  clip: DeckClip | undefined;
  number: number;
  onChange: (clip: DeckClip | undefined) => void;
}) {
  const [play, setPlay] = useState(0);
  const [state, setState] = useState<ClipState>('loading');
  if (!clip) {
    return (
      <div className="clip-line">
        <Key
          label="Add a pronunciation clip"
          context={`Word ${number}`}
          onPress={() => onChange({ url: '', start: null, end: null })}
        />
      </div>
    );
  }
  const problem = clipIsEmpty(clip) ? null : clipProblem(clip);
  const playable = clipToPlay(clip);
  const setUrl = (url: string) => {
    const link = parseYouTubeLink(url);
    // A link copied at the right moment already says where the word is.
    if (link?.start != null && clip.start === null) {
      onChange({ url, start: link.start, end: clip.end ?? roundClipTime(link.start + DEFAULT_CLIP_SECONDS) });
    } else {
      onChange({ url, start: clip.start, end: clip.end });
    }
    setPlay(0);
  };
  return (
    <div className="clip-line">
      <div className="clip-fields">
        <Field label={`Clip for word ${number}: YouTube link`}>
          {(id) => (
            <input
              id={id}
              className="field-input"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://youtu.be/…"
              maxLength={MAX_LINK}
              value={clip.url}
              onChange={(event) => setUrl(event.target.value)}
            />
          )}
        </Field>
        <TimeField label="From" placeholder="0:12" value={clip.start} onChange={(start) => onChange({ ...clip, start })} />
        <TimeField label="To" placeholder="0:15" value={clip.end} onChange={(end) => onChange({ ...clip, end })} />
        <div className="clip-keys">
          <Key label="Play" context={`Clip for word ${number}`} disabled={!playable} onPress={() => setPlay((count) => count + 1)} />
          <Key label="Remove" context={`Clip for word ${number}`} onPress={() => onChange(undefined)} />
        </div>
      </div>
      {problem && clip.url.trim() ? <p className="desk-error">{sentence(problem)}</p> : null}
      {playable && state === 'failed' && play > 0 ? (
        <p className="desk-error">YouTube wouldn't play this video. Check the link, or try another video.</p>
      ) : null}
      <p className="desk-hint">
        Up to {MAX_CLIP_SECONDS} seconds. The TV plays only the sound, 3 times with 5 seconds between, as the word goes
        up, and once more with H. The video only shows here.
      </p>
      {playable && play > 0 ? (
        <YouTubeClip
          className="clip-preview"
          clip={playable}
          play={play}
          muted={false}
          title={`Clip for word ${number}`}
          onState={setState}
        />
      ) : null}
    </div>
  );
}

export function DefineEditor({ game, onChange }: { game: DefineGame; onChange: (game: DefineGame) => void }) {
  const base = useId();
  const setItem = (index: number, change: Partial<DefineGame['items'][number]>) => {
    onChange({
      ...game,
      items: game.items.map((item, position) => (position === index ? { ...item, ...change } : item)),
    });
  };
  const setWhole = (index: number, next: DefineGame['items'][number]) => {
    onChange({ ...game, items: game.items.map((item, position) => (position === index ? next : item)) });
  };
  return (
    <>
      {game.items.length > 0 ? (
        <div className="word-head" aria-hidden="true">
          <span />
          <span>Word</span>
          <span>Real definition</span>
          <span />
        </div>
      ) : null}
      <ol className="word-rows">
        {game.items.map((item, index) => {
          const number = index + 1;
          return (
            <li key={index} className="word-row">
              <span className="row-number" aria-hidden="true">
                {number}
              </span>
              <span className="word-field">
                <label className="sr-only" htmlFor={`${base}-word-${index}`}>
                  Word {number}
                </label>
                <input
                  id={`${base}-word-${index}`}
                  className="field-input"
                  maxLength={MAX_WORD}
                  autoCapitalize="none"
                  spellCheck={false}
                  value={item.word}
                  onChange={(event) => setItem(index, { word: event.target.value })}
                />
              </span>
              <span className="word-field">
                <label className="sr-only" htmlFor={`${base}-definition-${index}`}>
                  Real definition of word {number}
                </label>
                <textarea
                  id={`${base}-definition-${index}`}
                  className="field-input"
                  rows={2}
                  maxLength={MAX_ANSWER_LENGTH}
                  value={item.definition}
                  onChange={(event) => setItem(index, { definition: event.target.value })}
                />
                {item.definition.length >= COUNT_FROM ? (
                  <span className="desk-count">
                    {item.definition.length}/{MAX_ANSWER_LENGTH}
                  </span>
                ) : null}
              </span>
              <RowKeys
                name={`word ${number}`}
                index={index}
                count={game.items.length}
                locked={false}
                onMove={(to) => onChange({ ...game, items: moved(game.items, index, to) })}
                onRemove={() => onChange({ ...game, items: game.items.filter((_, position) => position !== index) })}
              />
              <ClipEditor
                clip={item.clip}
                number={number}
                onChange={(clip) => {
                  // Removing a clip drops the key, so the saved deck looks like one from before clips.
                  const { clip: _old, ...rest } = item;
                  setWhole(index, clip ? { ...rest, clip } : rest);
                }}
              />
            </li>
          );
        })}
      </ol>
      <div className="add-row">
        <Key
          label="Add a word"
          disabled={game.items.length >= MAX_ITEMS_PER_GAME}
          onPress={() => onChange({ ...game, items: [...game.items, { word: '', definition: '' }] })}
        />
      </div>
      <Timing
        game={game}
        onChange={onChange}
        fields={[
          { key: 'writeSeconds', label: 'Writing (seconds)', placeholder: 60, seconds: true },
          { key: 'showSeconds', label: 'Showing each answer (seconds)', placeholder: 6, min: MIN_SHOW_SECONDS, max: MAX_SHOW_SECONDS },
          { key: 'voteSeconds', label: 'Voting (seconds)', placeholder: 45, seconds: true },
          { key: 'findReal', label: 'Finding the real one', placeholder: 1000 },
          { key: 'perFooled', label: 'Per person fooled', placeholder: 500 },
          { key: 'fooledMax', label: 'Most for fooling', placeholder: 1500 },
        ]}
      />
    </>
  );
}

export interface PhotoUploads {
  running: number;
  /** `full` says what's full, in the line about photos that didn't fit. */
  add: (files: File[], room: number, onAdded: (photo: AddedPhoto) => void, full?: string) => Promise<void>;
}

/** The drop target, plus what's happening to each photo while it's prepared and sent. */
export function PhotoDrop({ room, onAdded, uploads, compact = false, label, full }: {
  /** How many more photos fit. */
  room: number;
  onAdded: (photo: AddedPhoto) => void;
  uploads: PhotoUploads;
  compact?: boolean;
  label?: string;
  full?: string;
}) {
  const inputId = useId();
  const [over, setOver] = useState(false);

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    void uploads.add([...event.dataTransfer.files], room, onAdded, full);
  };

  const classes = ['dropzone', compact ? 'compact' : '', over ? 'over' : ''].filter(Boolean).join(' ');
  return (
    <label
      className={classes}
      htmlFor={inputId}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        id={inputId}
        className="sr-only"
        type="file"
        multiple
        accept="image/*,.heic,.heif,video/mp4,video/quicktime,.mp4,.m4v,.mov"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          void uploads.add(files, room, onAdded, full);
        }}
      />
      <span className="dropzone-main">{label ?? 'Drag photos or videos here, or click to choose'}</span>
      {compact ? null : (
        <span className="desk-hint">
          iPhone photos work too. Videos can be MP4 or MOV up to {MAX_VIDEO_MB} MB, and play on the TV. Locations
          and camera details are removed.
        </span>
      )}
    </label>
  );
}

/**
 * More photos from the same moment, shown on the TV once the photo's round is over, so the
 * presenter can tell the story behind it.
 */
function ExtraPhotos({ name, extras, uploads, onChange }: {
  /** Which photo these belong to, such as "photo 2". */
  name: string;
  extras: readonly string[];
  uploads: PhotoUploads;
  onChange: (update: (extras: string[]) => string[]) => void;
}) {
  const room = MAX_EXTRA_PHOTOS - extras.length;
  return (
    <div className="extras" role="group" aria-label={`More photos after ${name}`}>
      <p className="extras-head">
        More photos after the reveal{' '}
        <span className="desk-hint">
          {extras.length} of {MAX_EXTRA_PHOTOS}
        </span>
      </p>
      {extras.length > 0 ? (
        <ol className="extras-list">
          {extras.map((image, index) => (
            <li key={image} className="extras-item">
              <MediaThumb id={image} alt={`More after ${name}, ${isVideoId(image) ? 'video' : 'photo'} ${index + 1}`} />
              <Key
                label="Remove"
                context={`More after ${name}, photo ${index + 1}`}
                disabled={uploads.running > 0}
                onPress={() => onChange((current) => current.filter((other) => other !== image))}
              />
            </li>
          ))}
        </ol>
      ) : null}
      {room > 0 ? (
        <PhotoDrop
          compact
          room={room}
          uploads={uploads}
          label="Add photos or videos to show after this one"
          full={`${name} already has ${MAX_EXTRA_PHOTOS} more photos`}
          onAdded={(photo) => onChange((current) => [...current, photo.id].slice(0, MAX_EXTRA_PHOTOS))}
        />
      ) : null}
    </div>
  );
}

export function GeoEditor({ game, country, uploads, onChange }: {
  game: GeoGame;
  country: string;
  uploads: PhotoUploads;
  onChange: (update: (game: GeoGame) => GeoGame) => void;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [fromPhoto, setFromPhoto] = useState<ReadonlySet<string>>(new Set());
  const area = findCountry(country);

  const setItem = (image: string, change: Partial<GeoGame['items'][number]>) => {
    onChange((current) => ({
      ...current,
      items: current.items.map((item) => (item.image === image ? { ...item, ...change } : item)),
    }));
  };

  return (
    <>
      <ol className="photo-rows">
        {game.items.map((item, index) => {
          const number = index + 1;
          const located = item.lat !== null && item.lng !== null;
          const outside = located && area && !insideCountry(area, item.lat!, item.lng!);
          return (
            <li key={item.image} className="photo-row">
              <MediaThumb id={item.image} alt={`${isVideoId(item.image) ? 'Video' : 'Photo'} ${number}`} />
              <div className="photo-fields">
                <Field label={`Place name, photo ${number}`}>
                  {(id) => (
                    <input
                      id={id}
                      className="field-input"
                      maxLength={MAX_PLACE_LABEL}
                      value={item.label}
                      onChange={(event) => setItem(item.image, { label: event.target.value })}
                    />
                  )}
                </Field>
                <p className={outside ? 'desk-error' : 'desk-hint'}>
                  {!located ? 'No location yet.' : null}
                  {located ? `${item.lat}, ${item.lng}` : null}
                  {located && outside ? ` is outside ${area!.name}.` : null}
                  {located && !outside && fromPhoto.has(item.image) ? ". From the photo's GPS, so check it's right." : null}
                </p>
                <Key
                  label={picking === item.image ? 'Hide map' : located ? 'Change location' : 'Set location'}
                  context={`Photo ${number}`}
                  onPress={() => setPicking((current) => (current === item.image ? null : item.image))}
                />
                <ExtraPhotos
                  name={`photo ${number}`}
                  extras={item.extras ?? []}
                  uploads={uploads}
                  onChange={(update) =>
                    onChange((current) => ({
                      ...current,
                      items: current.items.map((other) =>
                        other.image === item.image ? { ...other, extras: update(other.extras ?? []) } : other,
                      ),
                    }))
                  }
                />
              </div>
              <RowKeys
                name={`photo ${number}`}
                index={index}
                count={game.items.length}
                locked={uploads.running > 0}
                onMove={(to) => onChange((current) => ({ ...current, items: moved(current.items, index, to) }))}
                onRemove={() => {
                  onChange((current) => ({
                    ...current,
                    items: current.items.filter((other) => other.image !== item.image),
                  }));
                  setPicking((current) => (current === item.image ? null : current));
                }}
              />
              {picking === item.image ? (
                <div className="photo-picker">
                  <Suspense fallback={<p className="desk-hint">Loading the map…</p>}>
                    <LocationPicker
                      value={located ? { lat: item.lat!, lng: item.lng! } : null}
                      country={country}
                      onChange={(location) => {
                        setItem(item.image, location);
                        setFromPhoto((current) => {
                          const next = new Set(current);
                          next.delete(item.image);
                          return next;
                        });
                      }}
                      onClose={() => setPicking(null)}
                    />
                  </Suspense>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <PhotoDrop
        room={MAX_ITEMS_PER_GAME - game.items.length}
        uploads={uploads}
        onAdded={(photo) => {
          if (photo.location) setFromPhoto((current) => new Set(current).add(photo.id));
          onChange((current) => ({
            ...current,
            items: [
              ...current.items,
              { image: photo.id, label: '', lat: photo.location?.lat ?? null, lng: photo.location?.lng ?? null },
            ],
          }));
        }}
      />
      <Timing
        game={game}
        onChange={(next) => onChange(() => next)}
        fields={[
          { key: 'guessSeconds', label: 'Guessing (seconds)', placeholder: 45, seconds: true },
          { key: 'maxPoints', label: 'Most points per photo', placeholder: 1000 },
        ]}
      />
    </>
  );
}

export function CaptionEditor({ game, uploads, onChange }: {
  game: CaptionGame;
  uploads: PhotoUploads;
  onChange: (update: (game: CaptionGame) => CaptionGame) => void;
}) {
  return (
    <>
      <ol className="caption-grid">
        {game.items.map((item, index) => {
          const number = index + 1;
          return (
            <li key={item.image} className="caption-card">
              <MediaThumb id={item.image} alt={`${isVideoId(item.image) ? 'Video' : 'Photo'} ${number}`} />
              <RowKeys
                name={`photo ${number}`}
                index={index}
                count={game.items.length}
                locked={uploads.running > 0}
                onMove={(to) => onChange((current) => ({ ...current, items: moved(current.items, index, to) }))}
                onRemove={() =>
                  onChange((current) => ({
                    ...current,
                    items: current.items.filter((other) => other.image !== item.image),
                  }))
                }
              />
              <ExtraPhotos
                name={`photo ${number}`}
                extras={item.extras ?? []}
                uploads={uploads}
                onChange={(update) =>
                  onChange((current) => ({
                    ...current,
                    items: current.items.map((other) =>
                      other.image === item.image ? { ...other, extras: update(other.extras ?? []) } : other,
                    ),
                  }))
                }
              />
            </li>
          );
        })}
      </ol>
      <PhotoDrop
        room={MAX_ITEMS_PER_GAME - game.items.length}
        uploads={uploads}
        onAdded={(photo) => onChange((current) => ({ ...current, items: [...current.items, { image: photo.id }] }))}
      />
      <Timing
        game={game}
        onChange={(next) => onChange(() => next)}
        fields={[
          { key: 'writeSeconds', label: 'Writing (seconds)', placeholder: 75, seconds: true },
          { key: 'showSeconds', label: 'Showing each caption (seconds)', placeholder: 6, min: MIN_SHOW_SECONDS, max: MAX_SHOW_SECONDS },
          { key: 'voteSeconds', label: 'Voting (seconds)', placeholder: 45, seconds: true },
          { key: 'perVote', label: 'Per vote', placeholder: 200 },
          { key: 'voteMax', label: 'Most from votes', placeholder: 1500 },
          { key: 'topBonus', label: 'Top caption bonus', placeholder: 500 },
        ]}
      />
    </>
  );
}

/** Pick one: each photo gets a question and four answers, with the right one marked. */
export function ChoiceEditor({ game, uploads, onChange }: {
  game: ChoiceGame;
  uploads: PhotoUploads;
  onChange: (update: (game: ChoiceGame) => ChoiceGame) => void;
}) {
  const base = useId();
  const updateItem = (image: string, update: (item: ChoiceGame['items'][number]) => ChoiceGame['items'][number]) => {
    onChange((current) => ({
      ...current,
      items: current.items.map((item) => (item.image === image ? update(item) : item)),
    }));
  };

  return (
    <>
      <ol className="photo-rows">
        {game.items.map((item, index) => {
          const number = index + 1;
          return (
            <li key={item.image} className="photo-row">
              <MediaThumb id={item.image} alt={`${isVideoId(item.image) ? 'Video' : 'Photo'} ${number}`} />
              <div className="photo-fields">
                <Field label={`Question, photo ${number}`} hint="Optional. Without one, the TV asks which answer is right.">
                  {(id) => (
                    <input
                      id={id}
                      className="field-input"
                      maxLength={MAX_QUESTION}
                      value={item.question}
                      onChange={(event) => updateItem(item.image, (current) => ({ ...current, question: event.target.value }))}
                    />
                  )}
                </Field>
                <fieldset className="choice-fields">
                  <legend className="field-label">Answers, photo {number}</legend>
                  {item.options.map((option, position) => {
                    const letter = choiceLetter(position);
                    const textId = `${base}-${index}-option-${position}`;
                    return (
                      <div key={position} className="choice-field">
                        <label htmlFor={textId} className="choice-field-letter">
                          {letter}
                          <span className="sr-only">, photo {number}</span>
                        </label>
                        <input
                          id={textId}
                          className="field-input"
                          maxLength={MAX_CHOICE}
                          value={option}
                          onChange={(event) =>
                            updateItem(item.image, (current) => ({
                              ...current,
                              options: current.options.map((other, at) => (at === position ? event.target.value : other)),
                            }))
                          }
                        />
                        <label className="choice-field-right">
                          <input
                            type="radio"
                            name={`${base}-${index}-answer`}
                            checked={item.answer === position}
                            onChange={() => updateItem(item.image, (current) => ({ ...current, answer: position }))}
                          />
                          Right<span className="sr-only"> answer is {letter}, photo {number}</span>
                        </label>
                      </div>
                    );
                  })}
                </fieldset>
                <p className="desk-hint">Guests see the four in a shuffled order.</p>
                <ExtraPhotos
                  name={`photo ${number}`}
                  extras={item.extras ?? []}
                  uploads={uploads}
                  onChange={(update) => updateItem(item.image, (current) => ({ ...current, extras: update(current.extras ?? []) }))}
                />
              </div>
              <RowKeys
                name={`photo ${number}`}
                index={index}
                count={game.items.length}
                locked={uploads.running > 0}
                onMove={(to) => onChange((current) => ({ ...current, items: moved(current.items, index, to) }))}
                onRemove={() =>
                  onChange((current) => ({
                    ...current,
                    items: current.items.filter((other) => other.image !== item.image),
                  }))
                }
              />
            </li>
          );
        })}
      </ol>
      <PhotoDrop
        room={MAX_ITEMS_PER_GAME - game.items.length}
        uploads={uploads}
        onAdded={(photo) => onChange((current) => ({ ...current, items: [...current.items, emptyChoice(photo.id)] }))}
      />
      <Timing
        game={game}
        onChange={(next) => onChange(() => next)}
        fields={[
          { key: 'answerSeconds', label: 'Answering (seconds)', placeholder: 30, seconds: true },
          { key: 'points', label: 'Points for the right answer', placeholder: 1000 },
        ]}
      />
    </>
  );
}

/** One upload at a time, so a batch of big photos can't exhaust the browser's memory. */
function uploadProblem(error: unknown, video: boolean): string {
  const full = spaceFullMessage(error);
  if (full) return full;
  if (!video) return "couldn't read or upload this photo. Try again.";
  if (error instanceof VideoError && error.problem === 'kind') return 'only MP4 and MOV videos work. Export it as MP4.';
  if (error instanceof VideoError && error.problem === 'size') {
    return `videos can be up to ${MAX_VIDEO_MB} MB. Trim it or export it smaller.`;
  }
  if (error instanceof VideoError) return "this browser can't play it, so the TV may not either. Export it as H.264 MP4.";
  return "couldn't upload this video. Try again.";
}

export function usePhotoUploads() {
  const [running, setRunning] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  const uploads: PhotoUploads = {
    running,
    add: async (files, room, onAdded, full = 'this game already has the most photos it can hold') => {
      if (files.length === 0) return;
      setErrors([]);
      const taking = files.slice(0, Math.max(room, 0));
      const refused = files.slice(taking.length).map((file) => `${file.name}: ${full}.`);
      if (refused.length > 0) setErrors(refused);
      setRunning((count) => count + 1);
      try {
        for (const [index, file] of taking.entries()) {
          const video = isVideoFile(file);
          setLines([`${video ? 'Uploading' : 'Preparing'} ${file.name} (${index + 1} of ${taking.length})…`]);
          try {
            onAdded(await addMedia(file));
          } catch (error) {
            setErrors((current) => [...current, `${file.name}: ${uploadProblem(error, video)}`]);
          }
        }
      } finally {
        setLines([]);
        setRunning((count) => count - 1);
      }
    },
  };

  return { uploads, lines, errors };
}
