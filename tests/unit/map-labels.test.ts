import type { LayerSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { englishLabelChanges } from '../../client/src/map/labels.js';

function symbol(id: string, textField: unknown, filter?: unknown): LayerSpecification {
  return {
    id,
    type: 'symbol',
    source: 'openmaptiles',
    layout: { 'text-field': textField },
    ...(filter ? { filter } : {}),
  } as LayerSpecification;
}

describe('englishLabelChanges', () => {
  it('shows only readable names on a name label', () => {
    const [change] = englishLabelChanges([symbol('place', '{name:latin}\n{name:nonlatin}')]);
    expect(change?.textField).toEqual(['coalesce', ['get', 'name:en'], ['get', 'name:latin']]);
  });

  it('never falls back to the Japanese name', () => {
    const [change] = englishLabelChanges([symbol('place', ['get', 'name'])]);
    expect(JSON.stringify(change?.textField)).not.toContain('"name"');
  });

  it('hides labels that have no readable name', () => {
    const [change] = englishLabelChanges([symbol('road', '{name}')]);
    expect(change?.filter).toEqual(['any', ['has', 'name:en'], ['has', 'name:latin']]);
  });

  it('keeps a layer\'s existing filter', () => {
    const existing = ['==', 'class', 'city'];
    const [change] = englishLabelChanges([symbol('city', '{name}', existing)]);
    expect(change?.filter).toEqual(['all', existing, ['any', ['has', 'name:en'], ['has', 'name:latin']]]);
  });

  it('leaves road number shields and house numbers alone', () => {
    expect(englishLabelChanges([symbol('shield', '{ref}'), symbol('house', '{housenumber}')])).toEqual([]);
  });

  it('leaves layers that aren\'t labels alone', () => {
    const fill = { id: 'water', type: 'fill', source: 'openmaptiles' } as LayerSpecification;
    expect(englishLabelChanges([fill])).toEqual([]);
  });
});
