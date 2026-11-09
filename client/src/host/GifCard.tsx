import { useState } from 'react';
import { gifUrls, type Gif } from '../theme/gifs.js';

/**
 * A GIF pinned to the screen like a polaroid with a strip of tape. It stays hidden until it
 * has loaded, and never appears at all if it can't load, so a bad connection costs nothing.
 */
export function GifCard({ gif, className = '' }: { gif: Gif | null; className?: string }) {
  if (!gif) return null;
  // Keyed, so a new GIF starts from scratch rather than inheriting the last one's state.
  return <LoadedGif key={gif.id} gif={gif} className={className} />;
}

function LoadedGif({ gif, className }: { gif: Gif; className: string }) {
  const urls = gifUrls(gif);
  const [src, setSrc] = useState(urls.webp);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  if (state === 'failed') return null;
  return (
    <figure className={`gif-card ${state} ${className}`.trim()}>
      <span className="gif-tape" aria-hidden="true" />
      <img
        src={src}
        alt={gif.alt}
        referrerPolicy="no-referrer"
        decoding="async"
        onLoad={() => setState('ready')}
        onError={() => {
          if (src === urls.webp) setSrc(urls.gif);
          else setState('failed');
        }}
      />
      <figcaption>{gif.caption}</figcaption>
    </figure>
  );
}
