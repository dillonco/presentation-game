import type { Country } from './countries.js';

/** Distances and the in-country check. Holds no country data, so it stays small enough for a phone. */

export interface Spot {
  lat: number;
  lng: number;
}

/** A country's shape as polygons of rings of [lng, lat] points. */
export interface Outline {
  polygons: number[][][][];
}

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEGREE_LAT = 110.57;
const KM_PER_DEGREE_LNG = 111.32;
/** How far off the outline a pin still counts, so coastal and small-island guesses work. */
export const OUTLINE_TOLERANCE_KM = 20;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceKm(a: Spot, b: Spot): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Full marks on the spot, falling away smoothly so a near miss still feels good. */
export function pinPoints(km: number, scaleKm: number, maxPoints: number): number {
  return Math.round(maxPoints * Math.exp(-km / scaleKm));
}

/**
 * A tenth of the country's size, so the score measures how well you know this country: being
 * 50 km off is close in Japan and hopeless in Malta.
 */
export function countryScaleKm(country: Pick<Country, 'box'>): number {
  const [west, south, east, north] = country.box;
  const tenth = distanceKm({ lat: south, lng: west }, { lat: north, lng: east }) / 10;
  if (tenth >= 100) return Math.round(tenth / 50) * 50;
  return Math.max(5, Math.round(tenth / 5) * 5);
}

/** The name of a country's file in shared/outlines. */
export function countrySlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Keeps a longitude between -180 and 180, the way the outlines are stored. */
export function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function insideRing(lat: number, lng: number, ring: readonly number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Holes count too: a point inside an inner ring, like Lesotho in South Africa, isn't inside. */
function insidePolygon(lat: number, lng: number, polygon: readonly number[][][]): boolean {
  let inside = false;
  for (const ring of polygon) if (insideRing(lat, lng, ring)) inside = !inside;
  return inside;
}

function closeToRing(lat: number, lng: number, ring: readonly number[][], toleranceKm: number): boolean {
  const kmPerLng = KM_PER_DEGREE_LNG * Math.cos(radians(lat));
  const limit = toleranceKm * toleranceKm;
  const toPlane = (point: readonly number[]): [number, number] => [
    wrapLng((point[0] as number) - lng) * kmPerLng,
    ((point[1] as number) - lat) * KM_PER_DEGREE_LAT,
  ];
  let [ax, ay] = toPlane(ring[ring.length - 1] as number[]);
  for (const point of ring) {
    const [bx, by] = toPlane(point);
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    if (qx * qx + qy * qy <= limit) return true;
    ax = bx;
    ay = by;
  }
  return false;
}

/** On the country, or close enough to its edge. */
export function insideOutline(outline: Outline, spot: Spot, toleranceKm: number = OUTLINE_TOLERANCE_KM): boolean {
  const lng = wrapLng(spot.lng);
  for (const polygon of outline.polygons) {
    if (insidePolygon(spot.lat, lng, polygon)) return true;
  }
  return outline.polygons.some((polygon) => polygon.some((ring) => closeToRing(spot.lat, lng, ring, toleranceKm)));
}
