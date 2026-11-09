import { useMemo, useRef, type MouseEvent } from 'react';
import type { Country } from '../../../shared/countries.js';
import { wrapLng, type Outline, type Spot } from '../../../shared/geo.js';

const WIDTH = 1000;
const PIN_SIZE = 28;

function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

function latitudeOf(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

/** Plain arithmetic between the country's box and the drawing, in both directions. */
export function outlineProjection([west, south, east, north]: readonly [number, number, number, number]) {
  const top = mercatorY(north);
  const span = top - mercatorY(south);
  const scale = WIDTH / ((east - west) * (Math.PI / 180));
  const height = span * scale;
  return {
    height,
    toPoint(lng: number, lat: number): [number, number] {
      // Measured from the west edge, so a country crossing the 180° line stays in one piece.
      const east360 = lng < west ? lng + 360 : lng;
      return [((east360 - west) / (east - west)) * WIDTH, (top - mercatorY(lat)) * scale];
    },
    toSpot(x: number, y: number): Spot {
      return { lat: latitudeOf(top - y / scale), lng: wrapLng(west + (x / WIDTH) * (east - west)) };
    },
  };
}

export interface MapMark extends Spot {
  kind: 'pin' | 'target';
}

/**
 * The country drawn from the file that ships with the app. Shows while the map engine downloads,
 * and stands in for it on a device that can't run it, so a guest can always place a pin.
 */
export function OutlineMap({
  area,
  outline,
  pin = null,
  onPick,
  marks = [],
}: {
  area: Country;
  outline: Outline | null;
  pin?: Spot | null;
  onPick?: (spot: Spot) => void;
  marks?: readonly MapMark[];
}) {
  const projection = useMemo(() => outlineProjection(area.box), [area.name]);
  const path = useMemo(() => {
    if (!outline) return '';
    const parts: string[] = [];
    for (const polygon of outline.polygons) {
      for (const ring of polygon) {
        const points = ring.map(([lng, lat]) => {
          const [x, y] = projection.toPoint(lng as number, lat as number);
          return `${x.toFixed(1)} ${y.toFixed(1)}`;
        });
        parts.push(`M${points.join('L')}Z`);
      }
    }
    return parts.join('');
  }, [outline, projection]);
  const svg = useRef<SVGSVGElement>(null);

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const matrix = svg.current?.getScreenCTM()?.inverse();
    if (!onPick || !matrix || !svg.current) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    onPick(projection.toSpot(point.x, point.y));
  };

  const pinPoint = pin ? projection.toPoint(pin.lng, pin.lat) : null;
  return (
    <svg
      ref={svg}
      className="outline-map"
      role="img"
      aria-label={`Map of ${area.name}`}
      viewBox={`0 0 ${WIDTH} ${projection.height.toFixed(0)}`}
      onClick={onClick}
    >
      {path ? <path className="outline-land" d={path} fillRule="evenodd" /> : null}
      {marks.map((mark, index) => {
        const [x, y] = projection.toPoint(mark.lng, mark.lat);
        return mark.kind === 'target' ? (
          <path key={index} className="outline-target" d={`M${x - PIN_SIZE} ${y}H${x + PIN_SIZE}M${x} ${y - PIN_SIZE}V${y + PIN_SIZE}`} />
        ) : (
          <circle key={index} className="outline-pin" cx={x} cy={y} r={7} />
        );
      })}
      {pinPoint ? (
        <path
          className="outline-target"
          d={`M${pinPoint[0] - PIN_SIZE} ${pinPoint[1]}H${pinPoint[0] + PIN_SIZE}M${pinPoint[0]} ${pinPoint[1] - PIN_SIZE}V${pinPoint[1] + PIN_SIZE}`}
        />
      ) : null}
    </svg>
  );
}
