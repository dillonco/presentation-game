import { countrySlug, type Outline } from '../../../shared/geo.js';

// One small file per country, so a phone only ever downloads the one it needs.
const FILES = import.meta.glob<{ default: Outline }>('../../../shared/outlines/*.json');

export async function loadOutline(country: string): Promise<Outline | null> {
  const load = FILES[`../../../shared/outlines/${countrySlug(country)}.json`];
  return load ? (await load()).default : null;
}
