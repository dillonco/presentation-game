import maplibregl from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { Country } from '../../../shared/countries.js';
import type { Outline, Spot } from '../../../shared/geo.js';
import type { RevealPin } from '../../../shared/protocol.js';
import { PIN_REVEAL } from '../../../shared/reveal.js';
import { createGameMap } from './gameMap.js';

const PADDING = { top: 48, left: 48, right: 48, bottom: 48 };
/** Room around the closest pins, so their names aren't cut off by the edge of the map. */
const LANDING_PADDING = 140;
const LANDING_ZOOM = 11;
const COLOURS = { pin: '#2A2926', stroke: '#F5F2EA', accent: '#A8452F' };

const emptyCollection: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function pinFeatures(pins: readonly RevealPin[]) {
  return {
    type: 'FeatureCollection' as const,
    features: pins.map((pin, index) => ({
      type: 'Feature' as const,
      properties: { close: index < PIN_REVEAL.labelled },
      geometry: { type: 'Point' as const, coordinates: [pin.lng, pin.lat] },
    })),
  };
}

function linkFeatures(target: Spot, pins: readonly RevealPin[]) {
  return {
    type: 'FeatureCollection' as const,
    features: pins.slice(0, PIN_REVEAL.labelled).map((pin) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [target.lng, target.lat],
          [pin.lng, pin.lat],
        ],
      },
    })),
  };
}

/** Frames the real spot with the closest pins, so the room can see who nearly had it. */
function landingCamera(map: maplibregl.Map, target: Spot, pins: readonly RevealPin[]) {
  const bounds = new maplibregl.LngLatBounds([target.lng, target.lat], [target.lng, target.lat]);
  for (const pin of pins.slice(0, PIN_REVEAL.labelled)) bounds.extend([pin.lng, pin.lat]);
  return (
    map.cameraForBounds(bounds, { padding: LANDING_PADDING, maxZoom: LANDING_ZOOM }) ?? {
      center: [target.lng, target.lat] as [number, number],
      zoom: LANDING_ZOOM,
    }
  );
}

function marker(className: string, text?: string): HTMLElement {
  const element = document.createElement('div');
  element.className = className;
  // The map library labels its markers, and a label needs a role to go with it.
  element.setAttribute('role', 'img');
  // Always plain text, since names come from guests.
  if (text) element.textContent = text;
  return element;
}

/**
 * Everyone's pins land on the whole country, then the map flies to the real spot. Timed from the
 * server, so a refreshed TV picks up where it was, and Space skips to the end.
 */
export default function RevealMap({
  area,
  outline,
  target,
  pins,
  startedAt,
  endsAt,
  onFail,
}: {
  area: Country;
  outline: Outline | null;
  target: Spot;
  pins: readonly RevealPin[];
  startedAt: number;
  endsAt: number;
  onFail: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const failed = useRef(onFail);
  failed.current = onFail;
  const removed = useRef(false);

  useEffect(() => {
    if (!box.current) return;
    removed.current = false;
    let instance: maplibregl.Map;
    try {
      instance = createGameMap(box.current, area, outline, { padding: PADDING, interactive: false });
    } catch {
      failed.current();
      return;
    }
    instance.once('load', () => {
      instance.addSource('links', { type: 'geojson', data: emptyCollection });
      instance.addLayer({
        id: 'links',
        type: 'line',
        source: 'links',
        paint: { 'line-color': COLOURS.accent, 'line-width': 1.5, 'line-dasharray': [2, 2] },
      });
      instance.addSource('pins', { type: 'geojson', data: emptyCollection });
      instance.addLayer({
        id: 'pins',
        type: 'circle',
        source: 'pins',
        paint: {
          'circle-radius': ['case', ['get', 'close'], 7, 5],
          'circle-color': COLOURS.pin,
          'circle-opacity': 0.75,
          'circle-stroke-color': COLOURS.stroke,
          'circle-stroke-width': 1.5,
        },
      });
      setMap(instance);
    });
    const watcher = new ResizeObserver(() => instance.resize());
    watcher.observe(box.current);
    return () => {
      watcher.disconnect();
      removed.current = true;
      setMap(null);
      instance.remove();
    };
    // Created once per country, however often the game's state arrives. The outline is ready
    // before this appears, and the country's details never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [area.name]);

  // Every update from the server is a new copy of these, so they're compared by what they hold.
  const pinsKey = JSON.stringify(pins);
  const targetKey = `${target.lat},${target.lng}`;
  const finished = Date.now() >= endsAt;
  const latest = useRef({ target, pins, startedAt, endsAt });
  latest.current = { target, pins, startedAt, endsAt };

  useEffect(() => {
    if (map && !removed.current) {
      (map.getSource('pins') as maplibregl.GeoJSONSource | undefined)?.setData(pinFeatures(latest.current.pins));
    }
  }, [map, pinsKey]);

  useEffect(() => {
    if (!map) return;
    const { target, pins, startedAt, endsAt } = latest.current;
    const camera = landingCamera(map, target, pins);
    const flyAt = startedAt + PIN_REVEAL.flyAtMs;
    const landsAt = flyAt + PIN_REVEAL.flyMs;
    const added: maplibregl.Marker[] = [];

    const showTarget = () => {
      added.push(new maplibregl.Marker({ element: marker('pin-mark target') }).setLngLat([target.lng, target.lat]).addTo(map));
    };
    const showNames = () => {
      (map.getSource('links') as maplibregl.GeoJSONSource | undefined)?.setData(linkFeatures(target, pins));
      for (const pin of pins.slice(0, PIN_REVEAL.labelled)) {
        added.push(
          new maplibregl.Marker({ element: marker('map-name', pin.name), anchor: 'bottom', offset: [0, -10] })
            .setLngLat([pin.lng, pin.lat])
            .addTo(map),
        );
      }
    };

    const now = Date.now();
    const timers: number[] = [];
    if (now >= endsAt || now >= landsAt) {
      map.jumpTo(camera);
      showTarget();
      showNames();
    } else {
      timers.push(
        window.setTimeout(
          () => {
            showTarget();
            map.flyTo({ ...camera, duration: Math.max(500, landsAt - Date.now()) });
          },
          Math.max(0, flyAt - now),
        ),
        window.setTimeout(showNames, Math.max(0, landsAt - now)),
      );
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      // When leaving this screen the map has already gone, and there's nothing to tidy.
      if (removed.current) return;
      for (const item of added) item.remove();
      map.stop();
      (map.getSource('links') as maplibregl.GeoJSONSource | undefined)?.setData(emptyCollection);
    };
  }, [map, targetKey, pinsKey, finished]);

  return <div className="map-canvas" ref={box} />;
}
