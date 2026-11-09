import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findCountry, insideCountry } from '../shared/countries.js';
import { countrySlug, insideOutline, type Outline, type Spot } from '../shared/geo.js';

/** Beside the server in a build, which copies them to dist/outlines, and in shared/ otherwise. */
const FOLDERS = [new URL('../outlines/', import.meta.url), new URL('../shared/outlines/', import.meta.url)];

const loaded = new Map<string, Outline | null>();

function readOutline(country: string): Outline | null {
  const file = `${countrySlug(country)}.json`;
  for (const folder of FOLDERS) {
    try {
      return JSON.parse(readFileSync(fileURLToPath(new URL(file, folder)), 'utf8')) as Outline;
    } catch {
      // Not in this folder, so on to the next.
    }
  }
  return null;
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
