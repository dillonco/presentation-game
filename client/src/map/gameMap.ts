import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
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

/** North always stays up. Throws if the device can't run the map, and callers fall back to the outline. */
export function createGameMap(
  container: HTMLElement,
  area: Country,
  outline: Outline | null,
  options: { padding: maplibregl.PaddingOptions; interactive: boolean },
): maplibregl.Map {
  const map = new maplibregl.Map({
    container,
    style: baseStyle(outline),
    bounds: area.box,
    fitBoundsOptions: { padding: options.padding },
    interactive: options.interactive,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxZoom: 17,
    attributionControl: false,
    // Only a country crossing the 180° line needs to see past it.
    renderWorldCopies: area.reach[2] > 180 || area.box[2] > 180,
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
