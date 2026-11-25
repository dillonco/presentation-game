import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findCountry, insideCountry } from '../shared/countries.js';
import { countrySlug, insideOutline, type Outline, type Spot } from '../shared/geo.js';

/** shared/outlines in development. The build copies them to dist/shared/outlines, the same place relative to the server. */
const FOLDER = new URL('../shared/outlines/', import.meta.url);

const loaded = new Map<string, Outline | null>();

function readOutline(country: string): Outline | null {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL(`${countrySlug(country)}.json`, FOLDER)), 'utf8')) as Outline;
  } catch {
    return null;
  }
}

function outlineOf(country: string): Outline | null {
  if (!loaded.has(country)) loaded.set(country, readOutline(country));
  return loaded.get(country)!;
}

/** Whether a pin counts as being in this country. Falls back to its rough box without an outline. */
export function spotAllowed(country: string, spot: Spot): boolean {
  const outline = outlineOf(country);
  if (outline) return insideOutline(outline, spot);
  const area = findCountry(country);
  return area ? insideCountry(area, spot.lat, spot.lng) : true;
}
