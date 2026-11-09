import { useCallback, useEffect, useRef, useState } from 'react';
import { isVideoId } from '../../../shared/deck.js';
import { isMuted } from '../host/sound.js';
import { mediaUrl, videoUrl } from '../theme/games.js';

const FIRST_RETRY_MS = 1500;
const LONGEST_RETRY_MS = 15_000;

/**
 * Keeps trying in the background on a bad connection, because the game carries on without the
 * photo. A photo this browser already has appears at once, with no fade.
 */
function useRetryingPhoto(image: string, size: 'full' | 'small') {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [instant, setInstant] = useState(false);
  const retry = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(retry.current), []);

  const ref = useCallback((element: HTMLImageElement | null) => {
    if (element?.complete && element.naturalWidth > 0) {
      setInstant(true);
      setLoaded(true);
      setFailed(false);
    }
  }, []);

  const src = attempt === 0 ? mediaUrl(image, size) : `${mediaUrl(image, size)}?try=${attempt}`;
  return {
    ref,
    src,
    loaded,
    failed,
    className: loaded && !instant ? 'photo-fade' : undefined,
    style: loaded ? undefined : { opacity: 0 },
    onLoad: () => {
      setLoaded(true);
      setFailed(false);
    },
    onError: () => {
      setFailed(true);
      window.clearTimeout(retry.current);
      const wait = Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
      retry.current = window.setTimeout(() => setAttempt((current) => current + 1), wait);
    },
  };
}

/**
 * Plays on a loop, showing its poster until it can. It has sound when the presenter's sound is on
 * and the browser allows it, and plays silently otherwise rather than not at all.
 */
function TvVideo({ image, alt, sound }: { image: string; alt: string; sound: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const retry = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(retry.current), []);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.muted = !sound;
    element.play().catch((error: unknown) => {
      // Browsers only allow sound once someone has clicked or pressed a key on the page.
      if ((error as { name?: string }).name !== 'NotAllowedError') return;
      element.muted = true;
      void element.play().catch(() => undefined);
    });
  }, [attempt, sound]);

  const src = attempt === 0 ? videoUrl(image) : `${videoUrl(image)}?try=${attempt}`;
  return (
    <video
      ref={video}
      src={src}
      poster={mediaUrl(image, 'full')}
      aria-label={alt}
      loop
      playsInline
      preload="auto"
      onError={() => {
        window.clearTimeout(retry.current);
        const wait = Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt);
        retry.current = window.setTimeout(() => setAttempt((current) => current + 1), wait);
      }}
    />
  );
}

/** Space is held for it whether or not it has loaded, so nothing shifts when it arrives. */
export function TvPhoto({ image, alt }: { image: string; alt: string }) {
  if (isVideoId(image)) {
    return (
      <figure className="tv-photo">
        <TvVideo image={image} alt={alt} sound={!isMuted()} />
      </figure>
    );
  }
  return <TvStill image={image} alt={alt} />;
}

function TvStill({ image, alt }: { image: string; alt: string }) {
  const photo = useRetryingPhoto(image, 'full');
  return (
    <figure className="tv-photo">
      <img
        ref={photo.ref}
        src={photo.src}
        alt={alt}
        className={photo.className}
        style={photo.style}
        onLoad={photo.onLoad}
        onError={photo.onError}
      />
      {photo.failed && !photo.loaded ? <p className="photo-missing">The photo is on its way</p> : null}
    </figure>
  );
}

/**
 * One photo or video of the TV's gallery, which keeps retrying like the round's own photo.
 * Videos in the collage play silently, so several at once aren't a racket; one opened full screen has sound.
 */
export function GalleryPhoto({ image, alt, sound = false }: { image: string; alt: string; sound?: boolean }) {
  if (isVideoId(image)) return <TvVideo image={image} alt={alt} sound={sound && !isMuted()} />;
  return <GalleryStill image={image} alt={alt} />;
}

function GalleryStill({ image, alt }: { image: string; alt: string }) {
  const photo = useRetryingPhoto(image, 'full');
  return (
    <>
      <img
        ref={photo.ref}
        src={photo.src}
        alt={alt}
        className={photo.className}
        style={photo.style}
        onLoad={photo.onLoad}
        onError={photo.onError}
      />
      {photo.failed && !photo.loaded ? <span className="photo-missing">The photo is on its way</span> : null}
    </>
  );
}

/** A small picture to remind the guest what's on the TV, which opens larger when tapped. */
export function PhotoThumb({
  image,
  alt,
  vote = false,
  onMap = false,
}: {
  image: string;
  alt: string;
  vote?: boolean;
  onMap?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const photo = useRetryingPhoto(image, 'small');
  const opener = useRef<HTMLButtonElement>(null);
  const closer = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closer.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    opener.current?.focus({ preventScroll: true });
  };

  const classes = ['photo-thumb', vote ? 'vote' : '', onMap ? 'on-map' : ''].filter(Boolean).join(' ');
  if (photo.failed && !photo.loaded) {
    return (
      <div className={classes}>
        <p className="photo-missing">Photo's on the TV</p>
        {/* Out of sight, so it can keep trying until the photo arrives. */}
        <img
          ref={photo.ref}
          src={photo.src}
          alt=""
          hidden
          onLoad={photo.onLoad}
          onError={photo.onError}
        />
      </div>
    );
  }
  return (
    <>
      <button
        ref={opener}
        type="button"
        className={classes}
        aria-label={`Enlarge ${alt}`}
        onClick={() => setOpen(true)}
      >
        <img
          ref={photo.ref}
          src={photo.src}
          alt=""
          className={photo.className}
          style={photo.style}
          onLoad={photo.onLoad}
          onError={photo.onError}
        />
        <span className="photo-hint" aria-hidden="true">
          Enlarge
        </span>
      </button>
      {open ? (
        <button
          ref={closer}
          type="button"
          className="photo-large"
          aria-label={`Tap to close ${alt}`}
          onClick={close}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
          }}
        >
          <img src={photo.src} alt="" />
          <span className="photo-hint" aria-hidden="true">
            Tap to close
          </span>
        </button>
      ) : null}
    </>
  );
}
