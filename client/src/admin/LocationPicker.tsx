import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { findCountry } from '../../../shared/countries.js';
import { preferEnglishLabels } from '../map/labels.js';
import { Field, Key } from './controls.js';
import { roundCoordinate } from './photos.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const COORDINATES = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export interface PickedLocation {
  lat: number;
  lng: number;
}

function asText(value: PickedLocation | null): string {
  return value ? `${value.lat}, ${value.lng}` : '';
}

/** Reads coordinates in the "35.01, 135.77" form that maps give when you copy a place. */
export function parseCoordinates(text: string): PickedLocation | null {
  const match = COORDINATES.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: roundCoordinate(lat), lng: roundCoordinate(lng) };
}

export default function LocationPicker({ value, country, onChange, onClose }: {
  value: PickedLocation | null;
  country: string;
  onChange: (location: PickedLocation) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const reported = useRef(onChange);
  reported.current = onChange;
  const [text, setText] = useState(asText(value));
  const [textWrong, setTextWrong] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  // The parent passes a new object on every render, so effects follow the numbers instead.
  // Otherwise any re-render, such as the save status changing, wipes out what's being typed.
  const lat = value?.lat ?? null;
  const lng = value?.lng ?? null;

  useEffect(() => {
    setText(lat !== null && lng !== null ? asText({ lat, lng }) : '');
    setTextWrong(false);
  }, [lat, lng]);

  useEffect(() => {
    if (!box.current) return;
    const area = findCountry(country);
    let instance: maplibregl.Map;
    try {
      instance = new maplibregl.Map({
        container: box.current,
        style: STYLE_URL,
        // Starts on the photo's spot when it has one, and otherwise shows the whole country.
        ...(value
          ? { center: [value.lng, value.lat] as [number, number], zoom: 12 }
          : area
            ? { bounds: [area.box[0], area.box[1], area.box[2], area.box[3]] as [number, number, number, number] }
            : {}),
        dragRotate: false,
        pitchWithRotate: false,
        fitBoundsOptions: { padding: 24 },
      });
    } catch {
      // No graphics support. Pasted coordinates still work.
      setMapFailed(true);
      return;
    }
    instance.touchZoomRotate.disableRotation();
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    instance.on('style.load', () => preferEnglishLabels(instance));
    instance.on('error', () => {
      if (!instance.loaded()) setMapFailed(true);
    });
    instance.on('load', () => setMapFailed(false));
    instance.on('click', (event) => {
      reported.current({ lat: roundCoordinate(event.lngLat.lat), lng: roundCoordinate(event.lngLat.lng) });
    });
    map.current = instance;

    const watcher = new ResizeObserver(() => instance.resize());
    watcher.observe(box.current);
    return () => {
      watcher.disconnect();
      marker.current = null;
      map.current = null;
      instance.remove();
    };
    // The map is set up once. Later changes to the location only move the marker, below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);

  useEffect(() => {
    if (!map.current || lat === null || lng === null) return;
    if (!marker.current) {
      const element = document.createElement('div');
      element.className = 'pin-mark';
      element.setAttribute('role', 'img');
      marker.current = new maplibregl.Marker({ element, draggable: true }).setLngLat([lng, lat]);
      marker.current.addTo(map.current);
      marker.current.on('dragend', () => {
        const spot = marker.current!.getLngLat();
        reported.current({ lat: roundCoordinate(spot.lat), lng: roundCoordinate(spot.lng) });
      });
    } else {
      marker.current.setLngLat([lng, lat]);
    }
  }, [lat, lng]);

  const applyText = () => {
    const parsed = parseCoordinates(text);
    if (!parsed) {
      setTextWrong(text.trim() !== '');
      return;
    }
    setTextWrong(false);
    onChange(parsed);
    map.current?.flyTo({ center: [parsed.lng, parsed.lat], zoom: Math.max(map.current.getZoom(), 12) });
  };

  return (
    <div className="picker">
      <div className="picker-map" ref={box} />
      {mapFailed ? <p className="desk-hint">The map couldn't load. You can paste coordinates instead.</p> : null}
      <div className="picker-row">
        <Field
          label="Coordinates"
          hint={
            textWrong ? (
              <span className="desk-error">Use the form 35.0116, 135.7681.</span>
            ) : (
              'Click the map, drag the pin, or paste them here.'
            )
          }
        >
          {(id) => (
            <input
              id={id}
              className="field-input"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              aria-invalid={textWrong || undefined}
              onChange={(event) => setText(event.target.value)}
              onBlur={applyText}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyText();
                }
              }}
            />
          )}
        </Field>
        <Key label="Done" onPress={onClose} />
      </div>
    </div>
  );
}
