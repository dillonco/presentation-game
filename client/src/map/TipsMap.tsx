import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import type { TipView } from '../../../shared/protocol.js';
import { addStreets } from './gameMap.js';
import { baseStyle } from './streets.js';

const SINGLE_PLACE_ZOOM = 13;

/** Each tip's places carry its number, so the map and the list read together. */
export function placesOf(tips: readonly TipView[]) {
  return tips.flatMap((tip, index) => tip.places.map((place) => ({ ...place, number: index + 1 })));
}

function mark(number: number, name: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'tip-mark';
  element.setAttribute('role', 'img');
  // Always plain text.
  element.setAttribute('aria-label', name ? `${number}: ${name}` : String(number));
  element.textContent = String(number);
  return element;
}

/**
 * Every place from the tips, numbered to match the list. Framed to fit them all, with no
 * country outline, since a tip can be anywhere. Names stay in the list: beside the pins, nearby
 * places' names would overlap.
 */
export default function TipsMap({
  tips,
  interactive,
  padding,
  onFail,
}: {
  tips: readonly TipView[];
  interactive: boolean;
  padding: number;
  onFail: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const failed = useRef(onFail);
  failed.current = onFail;
  const placesKey = JSON.stringify(placesOf(tips));

  useEffect(() => {
    const places = placesOf(tips);
    if (!box.current || places.length === 0) return;
    const first = places[0]!;
    const bounds = new maplibregl.LngLatBounds([first.lng, first.lat], [first.lng, first.lat]);
    for (const place of places) bounds.extend([place.lng, place.lat]);
    const single = places.every((place) => place.lat === first.lat && place.lng === first.lng);

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: box.current,
        style: baseStyle(null),
        ...(single
          ? { center: [first.lng, first.lat] as [number, number], zoom: SINGLE_PLACE_ZOOM }
          : { bounds, fitBoundsOptions: { padding, maxZoom: SINGLE_PLACE_ZOOM } }),
        interactive,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxZoom: 17,
        attributionControl: false,
        // On a phone, one finger scrolls the page past the map; two move the map.
        cooperativeGestures: interactive,
      });
    } catch {
      failed.current();
      return;
    }
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
    // A failed tile is expected on a bad connection.
    map.on('error', () => undefined);
    let gone = false;
    map.once('load', () => {
      void addStreets(map, () => gone).catch(() => undefined);
    });
    for (const place of places) {
      new maplibregl.Marker({ element: mark(place.number, place.name) }).setLngLat([place.lng, place.lat]).addTo(map);
    }
    const watcher = new ResizeObserver(() => map.resize());
    watcher.observe(box.current);
    return () => {
      gone = true;
      watcher.disconnect();
      map.remove();
    };
    // Rebuilt only when the places themselves change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesKey, interactive, padding]);

  return <div className="map-canvas" ref={box} />;
}
