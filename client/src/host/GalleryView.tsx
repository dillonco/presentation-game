import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { HostScreen } from '../../../shared/protocol.js';
import { GAME_NAMES, roundPosition } from '../theme/games.js';
import { GalleryPhoto } from '../ui/Photo.js';

/**
 * More photos from the moment the round's photo was taken, so the presenter can tell the story
 * behind it. They land one after another as a collage; clicking one fills the screen, the arrow
 * keys step through them there, and Escape or another click goes back. Space moves on as usual.
 */
export function GalleryView({ screen }: { screen: Extract<HostScreen, { kind: 'gallery' }> }) {
  const { round, images, place } = screen;
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (open === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
      else if (event.key === 'ArrowRight') setOpen((index) => (index === null ? null : (index + 1) % images.length));
      else if (event.key === 'ArrowLeft') {
        setOpen((index) => (index === null ? null : (index - 1 + images.length) % images.length));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, images.length]);

  const position = roundPosition(round);
  return (
    <>
      <header className="tv-round-head gallery-head">
        <p className="tv-round-line">
          {GAME_NAMES[round.game]} · {position}
        </p>
      </header>
      <section className="gallery" aria-label="More photos">
        <h1 className="gallery-title">{place || 'More from this one'}</h1>
        <ul className={`gallery-grid count-${Math.min(images.length, 5)}`}>
          {images.map((image, index) => (
            <GalleryTile
              key={image}
              image={image}
              delay={0.15 + index * 0.18}
              alt={`More from ${position}, photo ${index + 1} of ${images.length}`}
              onOpen={() => setOpen(index)}
            />
          ))}
        </ul>
      </section>
      {open !== null ? (
        <div className="gallery-lightbox">
          <button type="button" className="gallery-close" onClick={() => setOpen(null)}>
            <GalleryPhoto
              key={images[open]}
              image={images[open]!}
              sound
              alt={`More from ${position}, photo ${open + 1} of ${images.length}`}
            />
          </button>
          {images.length > 1 ? (
            <p className="gallery-count" aria-live="polite">
              {open + 1} / {images.length}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * One print in the collage, shaped like its photo so none of it is cut off. Until the photo
 * arrives the print fills its space; then it shrinks to the photo's shape.
 */
function GalleryTile({ image, alt, delay, onOpen }: { image: string; alt: string; delay: number; onOpen: () => void }) {
  const tile = useRef<HTMLLIElement>(null);
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    const element = tile.current;
    if (!element) return;
    const measure = () => {
      const media = element.querySelector('img, video');
      const [width, height] =
        media instanceof HTMLVideoElement
          ? [media.videoWidth, media.videoHeight]
          : media instanceof HTMLImageElement
            ? [media.naturalWidth, media.naturalHeight]
            : [0, 0];
      if (width > 0 && height > 0) setRatio(width / height);
    };
    measure();
    // Load events don't bubble, but they can still be caught on the way down.
    element.addEventListener('load', measure, true);
    element.addEventListener('loadedmetadata', measure, true);
    return () => {
      element.removeEventListener('load', measure, true);
      element.removeEventListener('loadedmetadata', measure, true);
    };
  }, []);

  const shape = ratio === null ? undefined : ({ '--ratio': ratio } as CSSProperties);
  return (
    <li ref={tile} className="gallery-tile" style={{ animationDelay: `${delay}s` }}>
      <button type="button" className={ratio === null ? 'gallery-open' : 'gallery-open shaped'} style={shape} onClick={onOpen}>
        <GalleryPhoto image={image} alt={alt} />
      </button>
    </li>
  );
}
