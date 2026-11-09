// Builds shared/countries.ts, with every country's name and the box its map opens on, and
// shared/outlines, with one file for each country's shape.
// Run by hand with `node scripts/build-countries.mjs`. The results are committed.
// Country shapes come from Natural Earth (public domain), through the world-atlas package.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';

const topology = JSON.parse(readFileSync('node_modules/world-atlas/countries-50m.json', 'utf8'));
const countries = feature(topology, topology.objects.countries).features;

const LEFT_OUT = new Set(['Antarctica', 'Fr. S. Antarctic Lands', 'Heard I. and McDonald Is.', 'Indian Ocean Ter.']);
const FULL_NAMES = {
  'Antigua and Barb.': 'Antigua and Barbuda',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Central African Rep.': 'Central African Republic',
  'Dem. Rep. Congo': 'DR Congo',
  'Dominican Rep.': 'Dominican Republic',
  'Eq. Guinea': 'Equatorial Guinea',
  'Solomon Is.': 'Solomon Islands',
  'St. Kitts and Nevis': 'Saint Kitts and Nevis',
  'St. Vin. and Gren.': 'Saint Vincent and the Grenadines',
  'United States of America': 'United States',
};
/** About 1 km. Fine for telling land from sea, and it keeps Japan's file small enough for a phone. */
const OUTLINE_DETAIL_DEGREES = 0.008;
/** Far-off territories, like French Guiana or Hawaii, shouldn't zoom the opening view out to a whole ocean. */
const NEARBY_DEGREES = 25;

function countrySlug(name) {
  return name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Douglas-Peucker: keeps the points that matter to the shape. */
function simplify(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    let farthest = -1;
    let farthestDistance = tolerance * tolerance;
    for (let index = first + 1; index < last; index += 1) {
      const [px, py] = points[index];
      const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
      const qx = ax + t * dx - px;
      const qy = ay + t * dy - py;
      const distance = qx * qx + qy * qy;
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

/** Rings are closed, so a ring is split in two first. A tiny island still keeps a shape. */
function simplifyRing(ring) {
  const middle = Math.floor(ring.length / 2);
  const half = (points) => simplify(points, OUTLINE_DETAIL_DEGREES);
  const result = [...half(ring.slice(0, middle + 1)), ...half(ring.slice(middle)).slice(1)];
  const rounded = result.map(([lng, lat]) => [Math.round(lng * 1000) / 1000, Math.round(lat * 1000) / 1000]);
  const distinct = rounded.filter(
    (point, index) => index === 0 || point[0] !== rounded[index - 1][0] || point[1] !== rounded[index - 1][1],
  );
  // Somewhere as small as the Vatican would vanish at this detail, so it keeps its full shape.
  return distinct.length >= 4 ? distinct : ring;
}

function polygonsOf(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function boxOf(polygon, centreLng) {
  // Measured from the centre, so a country crossing the 180° line stays in one piece.
  const unwrap = (lng) => {
    let value = lng;
    while (value - centreLng > 180) value -= 360;
    while (value - centreLng < -180) value += 360;
    return value;
  };
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lng, lat] of polygon[0]) {
    const x = unwrap(lng);
    west = Math.min(west, x);
    east = Math.max(east, x);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west, south, east, north };
}

function area(box) {
  return (box.east - box.west) * (box.north - box.south);
}

const rows = [];
for (const country of countries) {
  const raw = country.properties.name;
  if (!raw || LEFT_OUT.has(raw) || !country.geometry) continue;
  const polygons = polygonsOf(country.geometry);
  const roughBoxes = polygons.map((polygon) => boxOf(polygon, polygon[0][0][0]));
  const largest = roughBoxes.reduce((best, box) => (area(box) > area(best) ? box : best));
  const centreLng = (largest.west + largest.east) / 2;
  const centreLat = (largest.south + largest.north) / 2;

  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  let [allWest, allSouth, allEast, allNorth] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of polygons) {
    const box = boxOf(polygon, centreLng);
    allWest = Math.min(allWest, box.west);
    allEast = Math.max(allEast, box.east);
    allSouth = Math.min(allSouth, box.south);
    allNorth = Math.max(allNorth, box.north);
    const near =
      Math.abs((box.west + box.east) / 2 - centreLng) <= NEARBY_DEGREES &&
      Math.abs((box.south + box.north) / 2 - centreLat) <= NEARBY_DEGREES;
    if (!near) continue;
    west = Math.min(west, box.west);
    east = Math.max(east, box.east);
    south = Math.min(south, box.south);
    north = Math.max(north, box.north);
  }

  // A little room around the edge, so coastal spots aren't flagged as outside.
  const pad = 0.5;
  const round = (value) => Math.round(value * 100) / 100;
  rows.push({
    name: FULL_NAMES[raw] ?? raw,
    box: [round(west - pad), round(Math.max(south - pad, -90)), round(east + pad), round(Math.min(north + pad, 90))],
    reach: [
      round(allWest - pad),
      round(Math.max(allSouth - pad, -90)),
      round(allEast + pad),
      round(Math.min(allNorth + pad, 90)),
    ],
  });
}
rows.sort((a, b) => a.name.localeCompare(b.name));

// The boxes above come from the middle level of detail, and outlines from the finest, which has
// the small islands: Yonaguni, Kumejima and the like are missing from anything coarser.
const fineTopology = JSON.parse(readFileSync('node_modules/world-atlas/countries-10m.json', 'utf8'));
const fineByName = new Map();
for (const country of feature(fineTopology, fineTopology.objects.countries).features) {
  if (!country.properties.name || !country.geometry) continue;
  fineByName.set(FULL_NAMES[country.properties.name] ?? country.properties.name, country);
}
rmSync('shared/outlines', { recursive: true, force: true });
mkdirSync('shared/outlines', { recursive: true });
const slugs = new Set();
let outlineBytes = 0;
for (const row of rows) {
  const slug = countrySlug(row.name);
  if (!slug || slugs.has(slug)) throw new Error(`Slug problem for ${row.name}: ${slug}`);
  slugs.add(slug);
  const country = fineByName.get(row.name);
  if (!country) throw new Error(`No outline for ${row.name}`);
  const polygons = polygonsOf(country.geometry)
    .map((polygon) => polygon.map(simplifyRing).filter((ring) => ring.length >= 3))
    .filter((polygon) => polygon.length > 0);
  const text = JSON.stringify({ polygons });
  outlineBytes += text.length;
  writeFileSync(`shared/outlines/${slug}.json`, text);
}
console.log(`${slugs.size} outlines, ${Math.round(outlineBytes / 1024)} KB`);

const body = rows.map((row) => `  { name: ${JSON.stringify(row.name)}, box: [${row.box.join(', ')}], reach: [${row.reach.join(', ')}] },`).join('\n');
writeFileSync(
  'shared/countries.ts',
  `// Made by scripts/build-countries.mjs from Natural Earth (public domain). Don't edit by hand.

export interface Country {
  name: string;
  /** Where the map opens: west, south, east, north. East can pass 180 for a country crossing that line. */
  box: [number, number, number, number];
  /** Everything it covers, including far-off places like Hawaii. */
  reach: [number, number, number, number];
}

export const COUNTRIES: readonly Country[] = [
${body}
];

export function findCountry(name: string): Country | undefined {
  return COUNTRIES.find((country) => country.name === name);
}

/** A rough check that can run anywhere. The server checks against the country's exact outline. */
export function insideCountry(country: Country, lat: number, lng: number): boolean {
  const [west, south, east, north] = country.reach;
  if (lat < south || lat > north) return false;
  return [lng, lng + 360, lng - 360].some((value) => value >= west && value <= east);
}
`,
);
console.log(`${rows.length} countries`);
for (const name of ['Japan', 'Italy', 'United States', 'France', 'Russia', 'New Zealand', 'Fiji']) {
  const row = rows.find((candidate) => candidate.name === name);
  console.log(name, row?.box, row?.reach);
}
