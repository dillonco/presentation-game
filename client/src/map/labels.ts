import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';

const READABLE_NAME = ['coalesce', ['get', 'name:en'], ['get', 'name:latin']];
const HAS_READABLE_NAME = ['any', ['has', 'name:en'], ['has', 'name:latin']];

export interface LabelChange {
  id: string;
  textField: unknown;
  filter: unknown;
}

/**
 * Works out how to make name labels readable for guests who don't read the local script.
 *
 * OpenStreetMap usually names places in their local script, such as Japanese. Each name label
 * now shows its English or romanized name. Labels with neither are hidden, which is
 * mostly minor roads and neighbourhoods. Labels that don't show a name, such as road
 * number shields and house numbers, are left alone.
 */
export function englishLabelChanges(layers: readonly LayerSpecification[]): LabelChange[] {
  const changes: LabelChange[] = [];
  for (const layer of layers) {
    if (layer.type !== 'symbol') continue;
    const textField = layer.layout?.['text-field'];
    if (!textField || !JSON.stringify(textField).includes('name')) continue;
    changes.push({
      id: layer.id,
      textField: READABLE_NAME,
      filter: layer.filter ? ['all', layer.filter, HAS_READABLE_NAME] : HAS_READABLE_NAME,
    });
  }
  return changes;
}

export function preferEnglishLabels(map: MapLibreMap): void {
  for (const change of englishLabelChanges(map.getStyle().layers ?? [])) {
    map.setLayoutProperty(change.id, 'text-field', change.textField);
    map.setFilter(change.id, change.filter as Parameters<MapLibreMap['setFilter']>[1]);
  }
}
