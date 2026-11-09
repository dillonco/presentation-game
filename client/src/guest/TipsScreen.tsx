import { useEffect, useRef, useState } from 'react';
import type { TipsScreen as TipsScreenData } from '../../../shared/protocol.js';
import { mediaUrl } from '../theme/games.js';
import { ActionButton, useLockedAction } from '../ui/ActionButton.js';
import { copyText, TipsMap, tipsAsText } from '../ui/tips.js';

const COPIED_MS = 2500;

/** The trip tips to take home: every place opens in Maps, and one button copies the lot. */
export function TipsScreen({ screen, title }: { screen: TipsScreenData; title: string }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const copy = useLockedAction(async () => {
    setCopied((await copyText(tipsAsText(title, screen.tips))) ? 'yes' : 'no');
  });

  // Selected once when it appears, so a long press copies the lot.
  const fallback = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (copied === 'no') fallback.current?.select();
  }, [copied]);

  useEffect(() => {
    if (copied !== 'yes') return;
    const timer = window.setTimeout(() => setCopied(null), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <main className="sheet tips-sheet">
      <div className="tips-scroll">
        <header className="tips-masthead">
          <p className="kicker">{title}</p>
          <h1 className="notice-title">If you go</h1>
        </header>
        <ol className="tips-phone-list">
          {screen.tips.map((tip, index) => (
            <li key={index} className="tips-phone-card">
              {tip.image ? <img className="tips-phone-photo" src={mediaUrl(tip.image, 'small')} alt="" loading="lazy" /> : null}
              <p className="tips-phone-heading">
                <span className="tip-number" aria-hidden="true">
                  {index + 1}
                </span>
                {tip.heading}
              </p>
              {tip.text ? <p className="tips-phone-text">{tip.text}</p> : null}
              {tip.places.length > 0 ? (
                <ul className="tips-phone-places">
                  {tip.places.map((place) => (
                    <li key={place.url}>
                      <a href={place.url} target="_blank" rel="noopener noreferrer">
                        {place.name || 'Open in Maps'} <span aria-hidden="true">↗</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
        <TipsMap className="tips-phone-map" tips={screen.tips} interactive padding={40} />
      </div>
      <div className="tips-copy">
        <p className="tips-copy-status" role="status">
          {copied === 'yes' ? 'Copied. Paste it into your notes.' : null}
          {copied === 'no' ? "This phone wouldn't copy it, so it's all here. Press and hold to copy." : null}
        </p>
        {copied === 'no' ? (
          <textarea
            className="tips-copy-text"
            readOnly
            rows={5}
            aria-label="Trip tips as text"
            value={tipsAsText(title, screen.tips)}
            ref={fallback}
          />
        ) : null}
        <ActionButton action={copy} label={copied === 'yes' ? 'Copied' : 'Copy all'} busyLabel="Copying…" />
      </div>
    </main>
  );
}
