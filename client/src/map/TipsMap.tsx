import maplibregl from 'maplibre-gl';
import type { TipView } from '../../../shared/protocol.js';
import { createMap, useMapInstance } from './gameMap.js';
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

/** Where the map starts: on the one spot, or framing them all. Null with no places. */
function framing(places: readonly { lat: number; lng: number }[], padding: number) {
  if (places.length === 0) return null;
  const lats = places.map((place) => place.lat);
  const lngs = places.map((place) => place.lng);
  const [west, south, east, north] = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  if (west === east && south === north) return { center: [west, south] as [number, number], zoom: SINGLE_PLACE_ZOOM };
  return {
    bounds: [west, south, east, north] as [number, number, number, number],
    fitBoundsOptions: { padding, maxZoom: SINGLE_PLACE_ZOOM },
  };
}

/**
 * Every place from the tips, numbered to match the list. Framed to fit them all, with no country
 * outline, since a tip can be anywhere. Names stay in the list: beside the pins, nearby places'
 * names would overlap. With no places, there's no map.
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
  const places = placesOf(tips);
  const view = framing(places, padding);
  const box = useMapInstance(
    (element) =>
      createMap(element, {
        style: baseStyle(null),
        ...view,
        interactive,
        // On a phone, one finger scrolls the page past the map; two move the map.
        cooperativeGestures: interactive,
      }),
    (map) => {
      for (const place of places) {
        new maplibregl.Marker({ element: mark(place.number, place.name) }).setLngLat([place.lng, place.lat]).addTo(map);
      }
    },
    onFail,
    // Rebuilt only when the places themselves change.
    [JSON.stringify(places), interactive, padding],
  );

  // With no box, the hook makes no map.
  return view ? <div className="map-canvas" ref={box} /> : null;
}
