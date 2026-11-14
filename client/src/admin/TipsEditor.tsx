import { useState } from 'react';
import {
  emptyTip,
  isMapLink,
  MAX_PLACE_NAME,
  MAX_TIP_HEADING,
  MAX_TIP_PLACES,
  MAX_TIP_TEXT,
  MAX_TIPS,
  type DeckTip,
} from '../../../shared/deck.js';
import { api, ApiError } from './api.js';
import { Field, Key } from './controls.js';
import { moved, PhotoDrop, RowKeys, type PhotoUploads } from './GameEditors.js';

/** Starting headings, so a new deck has the shape of a good tips page without anyone's answers. */
const SUGGESTED = ['Best bite', 'Best experience', 'Would skip', 'One tip for a first-timer'];

function lookUpProblem(error: unknown): string {
  if (error instanceof ApiError && error.body.error === 'not_a_map_link') {
    return 'Paste a Google Maps link, such as one from Share in the Maps app.';
  }
  if (error instanceof ApiError && error.body.error === 'place_not_found') {
    return "Couldn't find a place in that link. Open the place in Google Maps and share it again.";
  }
  return "Couldn't look up that link. Check the connection and try again.";
}

function PlaceAdder({ name, onAdd }: { name: string; onAdd: (place: DeckTip['places'][number]) => void }) {
  const [link, setLink] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const add = async () => {
    if (!link.trim()) return;
    setProblem(null);
    try {
      onAdd(await api.lookUpPlace(link.trim()));
      setLink('');
    } catch (error) {
      setProblem(lookUpProblem(error));
    }
  };
  return (
    <Field label={`Add a place to ${name}`} hint={problem ? <span className="desk-error">{problem}</span> : 'Paste a Google Maps link.'}>
      {(id) => (
        <span className="tip-link-row">
          <input
            id={id}
            className="field-input"
            type="url"
            inputMode="url"
            placeholder="https://maps.app.goo.gl/…"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void add();
              }
            }}
          />
          <Key label="Add place" busyLabel="Finding…" context={name} disabled={!link.trim()} onPress={add} />
        </span>
      )}
    </Field>
  );
}

/**
 * The page after the podium: a few headings with what you'd tell a friend going next. Places come
 * from Google Maps links, and go on a map on the TV and on every phone.
 */
export function TipsEditor({ tips, uploads, onChange }: {
  tips: DeckTip[];
  uploads: PhotoUploads;
  onChange: (update: (tips: DeckTip[]) => DeckTip[]) => void;
}) {
  const setTip = (index: number, change: (tip: DeckTip) => DeckTip) =>
    onChange((current) => current.map((tip, position) => (position === index ? change(tip) : tip)));

  return (
    <>
      <p className="desk-hint">
        Shown after the podium, with a map of the places. Guests can open each place and copy the whole page on their phones.
      </p>
      <ol className="photo-rows">
        {tips.map((tip, index) => {
          const name = `tip ${index + 1}`;
          return (
            <li key={index} className="photo-row tip-row">
              <div className="tip-photo-slot">
                {tip.image ? (
                  <>
                    <img className="photo-thumb" src={`/media/${tip.image}/small.jpg`} alt={`Photo for ${name}`} loading="lazy" />
                    <Key
                      label="Remove photo"
                      context={name}
                      disabled={uploads.running > 0}
                      onPress={() => setTip(index, (current) => ({ ...current, image: null }))}
                    />
                  </>
                ) : (
                  <PhotoDrop
                    compact
                    room={1}
                    uploads={uploads}
                    label="Add a photo"
                    full={`${name} already has a photo`}
                    onAdded={(photo) => setTip(index, (current) => ({ ...current, image: photo.id }))}
                  />
                )}
              </div>
              <div className="photo-fields">
                <Field label={`Heading, ${name}`}>
                  {(id) => (
                    <input
                      id={id}
                      className="field-input"
                      maxLength={MAX_TIP_HEADING}
                      placeholder="Best bite"
                      value={tip.heading}
                      onChange={(event) => setTip(index, (current) => ({ ...current, heading: event.target.value }))}
                    />
                  )}
                </Field>
                <Field label={`Tip, ${name}`}>
                  {(id) => (
                    <textarea
                      id={id}
                      className="field-input"
                      rows={2}
                      maxLength={MAX_TIP_TEXT}
                      value={tip.text}
                      onChange={(event) => setTip(index, (current) => ({ ...current, text: event.target.value }))}
                    />
                  )}
                </Field>
                {tip.places.length > 0 ? (
                  <ul className="tip-places-edit">
                    {tip.places.map((place, number) => (
                      <li key={`${place.url}-${number}`} className="tip-place-edit">
                        <Field label={`Place ${number + 1} name, ${name}`} hint={`${place.lat}, ${place.lng}`}>
                          {(id) => (
                            <input
                              id={id}
                              className="field-input"
                              maxLength={MAX_PLACE_NAME}
                              value={place.name}
                              onChange={(event) =>
                                setTip(index, (current) => ({
                                  ...current,
                                  places: current.places.map((other, position) =>
                                    position === number ? { ...other, name: event.target.value } : other,
                                  ),
                                }))
                              }
                            />
                          )}
                        </Field>
                        {/* Only a real Maps link becomes a link: an imported deck could hold anything. */}
                        {isMapLink(place.url) && (
                          <a className="desk-hint" href={place.url} target="_blank" rel="noopener noreferrer">
                            Check in Maps
                          </a>
                        )}
                        <Key
                          label="Remove"
                          context={`Place ${number + 1}, ${name}`}
                          onPress={() =>
                            setTip(index, (current) => ({
                              ...current,
                              places: current.places.filter((_, position) => position !== number),
                            }))
                          }
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {tip.places.length < MAX_TIP_PLACES ? (
                  <PlaceAdder
                    name={name}
                    onAdd={(place) =>
                      setTip(index, (current) => ({
                        ...current,
                        places: [...current.places, place].slice(0, MAX_TIP_PLACES),
                      }))
                    }
                  />
                ) : null}
              </div>
              <RowKeys
                name={name}
                index={index}
                count={tips.length}
                locked={uploads.running > 0}
                onMove={(to) => onChange((current) => moved(current, index, to))}
                onRemove={() => onChange((current) => current.filter((_, position) => position !== index))}
              />
            </li>
          );
        })}
      </ol>
      <div className="desk-actions add-row">
        <Key
          label="Add a tip"
          disabled={tips.length >= MAX_TIPS || uploads.running > 0}
          onPress={() => onChange((current) => [...current, emptyTip()])}
        />
        {tips.length === 0 ? (
          <Key
            label="Start with suggested headings"
            onPress={() => onChange(() => SUGGESTED.map((heading) => ({ ...emptyTip(), heading })))}
          />
        ) : null}
      </div>
    </>
  );
}
