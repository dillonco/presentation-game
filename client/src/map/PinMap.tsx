import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { Country } from '../../../shared/countries.js';
import type { Outline, Spot } from '../../../shared/geo.js';
import { createGameMap } from './gameMap.js';
import { viewLimits } from './streets.js';

/** The status line and button that float over the bottom of the map. */
const FOOT_HEIGHT = 128;
const PADDING = { top: 24, left: 24, right: 24, bottom: FOOT_HEIGHT + 24 };
/** Long enough to tell a tap from the first half of a double tap, which zooms instead. */
const DOUBLE_TAP_MS = 260;

export interface PinMapProps {
  area: Country;
  outline: Outline | null;
  pin: Spot | null;
  locked: boolean;
  onPick: (spot: Spot) => void;
  /** This device can't run the map, so the caller shows the outline instead. */
  onFail: () => void;
}

export default function PinMap({ area, outline, pin, locked, onPick, onFail }: PinMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const picked = useRef(onPick);
  picked.current = onPick;
  const failed = useRef(onFail);
  failed.current = onFail;
  const spot = useRef(pin);
  spot.current = pin;

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let instance: maplibregl.Map;
    try {
      instance = createGameMap(element, area, outline, { padding: PADDING, interactive: true });
    } catch {
      failed.current();
      return;
    }

    const fitLimits = () => {
      const { clientWidth, clientHeight } = element;
      if (clientWidth === 0 || clientHeight === 0) return;
      instance.setMaxBounds(viewLimits(area.reach, clientWidth, clientHeight, PADDING));
    };
    fitLimits();

    // A pan or pinch never gets here, because the map only reports a click when nothing moved.
    let pending: number | undefined;
    const cancelPending = () => {
      window.clearTimeout(pending);
      pending = undefined;
    };
    instance.on('click', (event) => {
      if (pending !== undefined) {
        cancelPending();
        return;
      }
      const { lat, lng } = event.lngLat.wrap();
      pending = window.setTimeout(() => {
        pending = undefined;
        picked.current({ lat, lng });
      }, DOUBLE_TAP_MS);
    });
    // A double tap on a phone may zoom without a second click.
    instance.on('zoomstart', cancelPending);

    // Keyboard users pan with the arrows, zoom with + and -, and drop the pin in the middle.
    const canvas = instance.getCanvas();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      const { lat, lng } = instance.getCenter().wrap();
      picked.current({ lat, lng });
    };
    canvas.addEventListener('keydown', onKey);
    canvas.setAttribute('aria-label', `Map of ${area.name}. Tap to drop your pin.`);

    // Keeps the canvas matched to its box when browser toolbars change or the phone turns.
    const watcher = new ResizeObserver(() => {
      instance.resize();
      fitLimits();
    });
    watcher.observe(element);
    setMap(instance);
    return () => {
      cancelPending();
      watcher.disconnect();
      canvas.removeEventListener('keydown', onKey);
      marker.current = null;
      setMap(null);
      instance.remove();
    };
    // Created once per country, however often the game's state arrives. The outline is ready
    // before this appears, and the country's details never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area.name]);

  useEffect(() => {
    if (!map) return;
    if (!pin) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      const element = document.createElement('div');
      element.className = 'pin-mark';
      // The map library labels its markers, and a label needs a role to go with it.
      element.setAttribute('role', 'img');
      const created = new maplibregl.Marker({ element }).setLngLat([pin.lng, pin.lat]).addTo(map);
      created.on('dragend', () => {
        const { lat, lng } = created.getLngLat().wrap();
        picked.current({ lat, lng });
        // A refused drag goes back to where the pin really is.
        if (spot.current) created.setLngLat([spot.current.lng, spot.current.lat]);
      });
      marker.current = created;
    } else {
      marker.current.setLngLat([pin.lng, pin.lat]);
    }
    marker.current.setDraggable(!locked);
  }, [map, pin, locked]);

  return (
    <>
      <div className="map-canvas" ref={box} />
      <div className="map-keys">
        <button
          type="button"
          className="map-key wide"
          onClick={() => map?.fitBounds(area.box, { padding: PADDING })}
        >
          Show all of {area.name}
        </button>
        <button type="button" className="map-key" aria-label="Zoom in" onClick={() => map?.zoomIn()}>
          +
        </button>
        <button type="button" className="map-key" aria-label="Zoom out" onClick={() => map?.zoomOut()}>
          −
        </button>
      </div>
    </>
  );
}
