import { lazy, Suspense, useEffect, useState } from 'react';
import type { TipView } from '../../../shared/protocol.js';

type TipsMapProps = Parameters<typeof import('../map/TipsMap.js').default>[0];

/** If the map engine can't arrive, it says so and the page carries on as a list. */
const LazyTipsMap = lazy(() =>
  import('../map/TipsMap.js').catch(() => ({
    default: ({ onFail }: TipsMapProps) => {
      useEffect(onFail, [onFail]);
      return <></>;
    },
  })),
);

export function hasPlaces(tips: readonly TipView[]): boolean {
  return tips.some((tip) => tip.places.length > 0);
}

/** The map, or nothing at all if this device can't draw one. */
export function TipsMap({ className, ...props }: Omit<TipsMapProps, 'onFail'> & { className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !hasPlaces(props.tips)) return null;
  return (
    <div className={className}>
      <Suspense fallback={null}>
        <LazyTipsMap {...props} onFail={() => setFailed(true)} />
      </Suspense>
    </div>
  );
}

/** Plain text that pastes cleanly into notes or a message, with every place's link. */
export function tipsAsText(title: string, tips: readonly TipView[]): string {
  const lines = [title, ''];
  for (const tip of tips) {
    lines.push(tip.text ? `${tip.heading}: ${tip.text}` : `${tip.heading}:`);
    for (const place of tip.places) lines.push(`  ${place.name || 'Map'}: ${place.url}`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

/** The clipboard needs a secure page and permission. Without either, a hidden text box still copies. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}
