import type { GeoJSONSourceSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { Outline } from '../../../shared/geo.js';
import { englishLabelChanges } from './labels.js';

export const STREET_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

/** The app's paper tones. This country is the lightest thing on the map, and the sea sits back. */
export const MAP_COLOURS = {
  sea: '#C7D3D0',
  land: '#E9E5D9',
  country: '#F5F2EA',
  edge: '#8E8A7E',
} as const;

/** Layer ids from OpenFreeMap's Positron style, moved from cool greys to warm ones. */
const PAPER_TONES: Record<string, [paint: string, colour: string]> = {
  water: ['fill-color', MAP_COLOURS.sea],
  waterway: ['line-color', MAP_COLOURS.sea],
  park: ['fill-color', '#E3E5D6'],
  landcover_wood: ['fill-color', '#DFE2D2'],
  landuse_residential: ['fill-color', '#EFEBDF'],
  building: ['fill-color', '#E6E2D5'],
};

export function outlineSource(outline: Outline | null): GeoJSONSourceSpecification {
  return {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: outline?.polygons ?? [] } },
  };
}

/**
 * What the map draws before any street data arrives, and all it needs to be playable: this needs
 * nothing from the network, so a guest can always place a pin.
 */
export function baseStyle(outline: Outline | null): StyleSpecification {
  return {
    version: 8,
    sources: { country: outlineSource(outline) },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': MAP_COLOURS.sea } },
      { id: 'country-fill', type: 'fill', source: 'country', paint: { 'fill-color': MAP_COLOURS.country } },
      {
        id: 'country-edge',
        type: 'line',
        source: 'country',
        // Marks where pins can go when zoomed out, and gets out of the way of the streets.
        paint: {
          'line-color': MAP_COLOURS.edge,
          'line-width': 1,
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 1, 10, 0],
        },
      },
    ],
  };
}

/** The street map's layers in the app's colours, with labels guests can read. */
export function streetLayers(style: StyleSpecification): LayerSpecification[] {
  const labels = new Map(englishLabelChanges(style.layers).map((change) => [change.id, change]));
  return style.layers
    .filter((layer) => layer.type !== 'background')
    .map((layer) => {
      const label = labels.get(layer.id);
      if (label) {
        return {
          ...layer,
          layout: { ...('layout' in layer ? layer.layout : {}), 'text-field': label.textField },
          filter: label.filter,
        } as LayerSpecification;
      }
      const tone = PAPER_TONES[layer.id];
      if (tone) {
        return { ...layer, paint: { ...('paint' in layer ? layer.paint : {}), [tone[0]]: tone[1] } } as LayerSpecification;
      }
      return layer;
    });
}

const SLACK = 1.3;
const LATITUDE_LIMIT = 85;

function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

function latitudeOf(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

/**
 * How far the map may pan. A map can't show anything past its limits, so plain limits around a
 * country would stop a tall phone ever seeing all of a wide country at once. These leave room for
 * the country to fit this screen, padding included.
 */
export function viewLimits(
  [west, south, east, north]: readonly [number, number, number, number],
  width: number,
  height: number,
  padding: { top: number; bottom: number; left: number; right: number },
): [number, number, number, number] {
  const spanX = ((east - west) * Math.PI) / 180;
  const top = mercatorY(north);
  const bottom = mercatorY(south);
  const spanY = top - bottom;
  const usableWidth = Math.max(1, width - padding.left - padding.right);
  const usableHeight = Math.max(1, height - padding.top - padding.bottom);
  const scale = Math.max(spanX / usableWidth, spanY / usableHeight);
  const halfX = (Math.max(spanX, scale * width * SLACK) * 180) / Math.PI / 2;
  const halfY = Math.max(spanY, scale * height * SLACK) / 2;
  const centreX = (west + east) / 2;
  const centreY = (top + bottom) / 2;
  return [
    centreX - halfX,
    Math.max(-LATITUDE_LIMIT, latitudeOf(centreY - halfY)),
    centreX + halfX,
    Math.min(LATITUDE_LIMIT, latitudeOf(centreY + halfY)),
  ];
}
