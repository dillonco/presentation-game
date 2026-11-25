import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, type DependencyList, type RefObject } from 'react';
import type { Country } from '../../../shared/countries.js';
import type { Outline } from '../../../shared/geo.js';
import { baseStyle, MAP_COLOURS, STREET_STYLE_URL, streetLayers } from './streets.js';

const STYLE_TRIES = 3;
const STYLE_RETRY_MS = 4000;

/** Street data comes from a free public service, so the game has to carry on without it. */
export async function addStreets(map: maplibregl.Map, isGone: () => boolean): Promise<void> {
  let style: StyleSpecification | null = null;
  for (let attempt = 0; attempt < STYLE_TRIES && !style; attempt += 1) {
    if (attempt > 0) await new Promise((done) => window.setTimeout(done, STYLE_RETRY_MS));
    if (isGone()) return;
    try {
      const response = await fetch(STREET_STYLE_URL);
      if (response.ok) style = (await response.json()) as StyleSpecification;
    } catch {
      // A dropped connection, so it tries again.
    }
  }
  if (!style || isGone()) return;
  if (style.glyphs) map.setGlyphs(style.glyphs);
  if (typeof style.sprite === 'string') map.setSprite(style.sprite);
  for (const [id, source] of Object.entries(style.sources)) map.addSource(id, source);
  for (const layer of streetLayers(style)) map.addLayer(layer, 'country-edge');
  // The sea colour stays until real data can draw the sea itself, then neighbours become land.
  const onData = (event: maplibregl.MapSourceDataEvent) => {
    if (event.isSourceLoaded && style!.sources[event.sourceId]) {
      map.setPaintProperty('background', 'background-color', MAP_COLOURS.land);
      map.off('sourcedata', onData);
    }
  };
  map.on('sourcedata', onData);
}

/**
 * North always stays up, the streets arrive when they can, and a failed tile is ignored.
 * Throws if the device can't run the map, and callers fall back to something simpler.
 */
export function createMap(container: HTMLElement, options: Omit<maplibregl.MapOptions, 'container'>): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxZoom: 17,
    attributionControl: false,
    ...options,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
  // A failed tile is expected on a bad connection. With no listener it would be logged as an error.
  map.on('error', () => undefined);
  let gone = false;
  map.once('remove', () => {
    gone = true;
  });
  map.once('load', () => {
    void addStreets(map, () => gone).catch(() => undefined);
  });
  return map;
}

/** One country, framed whole, with its outline drawn over the streets. */
export function createGameMap(
  container: HTMLElement,
  area: Country,
  outline: Outline | null,
  options: { padding: maplibregl.PaddingOptions; interactive: boolean },
): maplibregl.Map {
  return createMap(container, {
    style: baseStyle(outline),
    bounds: area.box,
    fitBoundsOptions: { padding: options.padding },
    interactive: options.interactive,
    // Only a country crossing the 180° line needs to see past it.
    renderWorldCopies: area.reach[2] > 180 || area.box[2] > 180,
  });
}

interface MapSetup {
  /** Runs after the map follows a change in its box's size. */
  resize?: () => void;
  cleanup?: () => void;
}

/**
 * A map in the returned box, made again only when `deps` change, kept matched to the box's size,
 * and removed with the component. `setup` adds what this map needs. If the device can't run a
 * map, `onFail` is called instead.
 */
export function useMapInstance(
  create: (container: HTMLDivElement) => maplibregl.Map,
  setup: (map: maplibregl.Map, container: HTMLDivElement) => MapSetup | void,
  onFail: () => void,
  deps: DependencyList,
): RefObject<HTMLDivElement> {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ create, setup, onFail });
  latest.current = { create, setup, onFail };
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    let map: maplibregl.Map;
    try {
      map = latest.current.create(element);
    } catch {
      latest.current.onFail();
      return;
    }
    const extra = latest.current.setup(map, element) ?? {};
    // Keeps the canvas matched to its box when browser toolbars change or a phone turns.
    const watcher = new ResizeObserver(() => {
      map.resize();
      extra.resize?.();
    });
    watcher.observe(element);
    return () => {
      watcher.disconnect();
      extra.cleanup?.();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return box;
}
