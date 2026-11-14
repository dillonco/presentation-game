import { isMapLink, MAX_PLACE_NAME, type TipPlace } from '../shared/deck.js';
import { cleanName } from '../shared/names.js';

const MAX_HOPS = 4;
const HOP_TIMEOUT_MS = 5000;

export type PlaceLookup = { ok: true; place: TipPlace } | { ok: false; error: 'not_a_map_link' | 'place_not_found' };

function isShortLink(url: URL): boolean {
  return url.hostname === 'maps.app.goo.gl' || url.hostname === 'goo.gl';
}

/** A name from the address, left as it is when its escapes are broken, since the spot is what matters. */
function decodeName(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * Reads the place's name and spot from a full Google Maps address. The pin's own spot (`!3d…!4d…`)
 * wins over the camera's (`@lat,lng`), which is often zoomed out far from it.
 */
export function placeFromMapUrl(value: string): Omit<TipPlace, 'url'> | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const path = url.pathname;
  const named = /\/maps\/place\/([^/]+)/.exec(path);
  const rawName = named ? decodeName(named[1]!.replaceAll('+', ' ')) : (url.searchParams.get('q') ?? '');

  const number = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
  const pins = [...value.matchAll(new RegExp(String.raw`!3d${number}!4d${number}`, 'g'))];
  const pin = pins.at(-1);
  const camera = new RegExp(String.raw`@${number},${number}`).exec(path);
  const query = new RegExp(String.raw`^${number},\s*${number}$`).exec(url.searchParams.get('q') ?? url.searchParams.get('query') ?? '');
  const found = pin ?? query ?? camera;
  if (!found) return null;
  const lat = Number(found[1]);
  const lng = Number(found[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  // A query of bare coordinates has no name worth showing.
  const name = query && !named ? '' : cleanName(rawName).slice(0, MAX_PLACE_NAME);
  return { name, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

/**
 * Turns a Google Maps link, short or full, into a named spot for the tips map. Short links are
 * followed one hop at a time, and only ever to Google Maps, so this can't be pointed elsewhere.
 * The full page itself is never fetched: its address already holds everything needed.
 */
export async function lookUpPlace(link: string, fetcher: typeof fetch = fetch): Promise<PlaceLookup> {
  const original = link.trim();
  if (!isMapLink(original)) return { ok: false, error: 'not_a_map_link' };
  let current = new URL(original);
  for (let hop = 0; hop < MAX_HOPS && isShortLink(current); hop += 1) {
    let response: Response;
    try {
      response = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(HOP_TIMEOUT_MS) });
    } catch {
      return { ok: false, error: 'place_not_found' };
    }
    const next = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!next) return { ok: false, error: 'place_not_found' };
    const target = new URL(next, current);
    if (!isMapLink(target.href)) return { ok: false, error: 'place_not_found' };
    current = target;
  }
  const place = placeFromMapUrl(current.href);
  if (!place) return { ok: false, error: 'place_not_found' };
  return { ok: true, place: { ...place, url: original } };
}
