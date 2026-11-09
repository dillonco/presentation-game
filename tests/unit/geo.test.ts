import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COUNTRIES, findCountry } from '../../shared/countries.js';
import { countryScaleKm, countrySlug, distanceKm, insideOutline, pinPoints, wrapLng, type Outline } from '../../shared/geo.js';
import { spotAllowed } from '../../server/outlines.js';

function outline(country: string): Outline {
  return JSON.parse(readFileSync(`shared/outlines/${countrySlug(country)}.json`, 'utf8')) as Outline;
}

describe('distance', () => {
  it('matches known distances', () => {
    const tokyo = { lat: 35.6812, lng: 139.7671 };
    const kyoto = { lat: 35.0116, lng: 135.7681 };
    const sapporo = { lat: 43.0618, lng: 141.3545 };
    expect(distanceKm(tokyo, kyoto)).toBeCloseTo(370, -1);
    expect(distanceKm(tokyo, sapporo)).toBeCloseTo(830, -1);
    expect(distanceKm(tokyo, tokyo)).toBe(0);
  });

  it('goes the short way across the 180° line', () => {
    expect(distanceKm({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(111, 0);
  });
});

describe('points by distance', () => {
  // The values promised in the plan, with Japan's scale.
  it.each([
    [0, 1000],
    [50, 846],
    [300, 368],
    [1000, 36],
  ])('%d km earns %d of 1000', (km, points) => {
    expect(pinPoints(km, 300, 1000)).toBe(points);
  });

  it('never goes up with distance, and never below zero', () => {
    let last = Infinity;
    for (let km = 0; km < 5000; km += 50) {
      const points = pinPoints(km, 300, 1000);
      expect(points).toBeLessThanOrEqual(last);
      expect(points).toBeGreaterThanOrEqual(0);
      last = points;
    }
  });

  it('follows a changed maximum', () => {
    expect(pinPoints(0, 300, 2500)).toBe(2500);
    expect(pinPoints(0, 300, 0)).toBe(0);
  });
});

describe("each country's scale", () => {
  it('is about 300 km for Japan', () => {
    expect(countryScaleKm(findCountry('Japan')!)).toBe(300);
  });

  it('is much smaller for a small country, and never zero', () => {
    expect(countryScaleKm(findCountry('Italy')!)).toBeLessThan(300);
    for (const country of COUNTRIES) expect(countryScaleKm(country)).toBeGreaterThan(0);
  });
});

describe('wrapping longitude', () => {
  it.each([
    [0, 0],
    [181, -179],
    [-181, 179],
    [539, 179],
    [179.5, 179.5],
  ])('%d becomes %d', (lng, wrapped) => {
    expect(wrapLng(lng)).toBeCloseTo(wrapped, 9);
  });
});

describe('the outline of Japan', () => {
  const japan = outline('Japan');

  it.each([
    ['Tokyo', 35.68, 139.76],
    ['Kyoto', 35.01, 135.77],
    ['Sapporo', 43.06, 141.35],
    ['Naha, Okinawa', 26.21, 127.68],
    ['Ishigaki', 24.34, 124.16],
    ['Yonaguni, the far west', 24.47, 123.0],
    ['Kumejima', 26.34, 126.8],
    ['Sado', 38.02, 138.37],
    ['Tsushima', 34.2, 129.29],
    ['Chichijima, Ogasawara', 27.09, 142.19],
    ['Naoshima', 34.46, 133.99],
    ['Miyajima', 34.3, 132.32],
    ['Just off Kamakura beach', 35.29, 139.53],
  ])('accepts %s', (_name, lat, lng) => {
    expect(insideOutline(japan, { lat, lng })).toBe(true);
  });

  it.each([
    ['Seoul', 37.56, 126.97],
    ['Busan', 35.18, 129.07],
    ['Taipei', 25.03, 121.56],
    ['Vladivostok', 43.11, 131.88],
    ['Sakhalin', 47.0, 142.7],
    ['Mid-Pacific east of Tokyo', 36, 145],
    ['Rome', 41.9, 12.5],
    ['the far side of the world', -35, -40],
  ])('refuses %s', (_name, lat, lng) => {
    expect(insideOutline(japan, { lat, lng })).toBe(false);
  });

  it('allows about 20 km of tolerance, and no more', () => {
    // Choshi, the eastern tip of Honshu, then straight out to sea.
    const coast = { lat: 35.7, lng: 140.87 };
    const kmPerDegree = distanceKm(coast, { lat: coast.lat, lng: coast.lng + 1 });
    expect(insideOutline(japan, { lat: coast.lat, lng: coast.lng + 15 / kmPerDegree })).toBe(true);
    expect(insideOutline(japan, { lat: coast.lat, lng: coast.lng + 30 / kmPerDegree })).toBe(false);
  });
});

describe('other outlines', () => {
  it('has a file for every country', () => {
    for (const country of COUNTRIES) {
      const shape = outline(country.name);
      expect(shape.polygons.length, country.name).toBeGreaterThan(0);
    }
  });

  it('handles a country crossing the 180° line', () => {
    const fiji = outline('Fiji');
    expect(insideOutline(fiji, { lat: -17.8, lng: 178 })).toBe(true);
    // Two of its islands sit either side of the line.
    expect(insideOutline(fiji, { lat: -16.8, lng: -179.95 })).toBe(true);
    expect(insideOutline(fiji, { lat: -17.8, lng: -170 })).toBe(false);
  });

  it('treats a hole as outside: Lesotho is not South Africa', () => {
    const southAfrica = outline('South Africa');
    expect(insideOutline(southAfrica, { lat: -26.2, lng: 28.05 })).toBe(true);
    expect(insideOutline(southAfrica, { lat: -29.5, lng: 28.2 })).toBe(false);
  });
});

describe('the server check', () => {
  it('reads each country from its own file', () => {
    expect(spotAllowed('Japan', { lat: 35.68, lng: 139.76 })).toBe(true);
    expect(spotAllowed('Japan', { lat: 41.9, lng: 12.5 })).toBe(false);
    expect(spotAllowed('Italy', { lat: 41.9, lng: 12.5 })).toBe(true);
    expect(spotAllowed('Italy', { lat: 35.68, lng: 139.76 })).toBe(false);
  });
});
