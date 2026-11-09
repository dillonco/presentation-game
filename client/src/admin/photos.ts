import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES } from '../../../shared/deck.js';
import { api, ApiError } from './api.js';

const FULL_SIDE = 1920;
const SMALL_SIDE = 960;
/** Phones on a weak signal get about this much, so a photo still arrives in time to play. */
const SMALL_TARGET_BYTES = 170 * 1024;
const ATTEMPTS = 3;
const MAX_METADATA_TRIES = 8;

export interface AddedPhoto {
  id: string;
  /** From the photo's own GPS data, when it has any. */
  location: { lat: number; lng: number } | null;
}

/** Windows often gives iPhone photos no type at all, so this also checks the file itself. */
async function isHeic(file: File): Promise<boolean> {
  if (/^image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(4, 12).arrayBuffer());
  const brand = String.fromCharCode(...head);
  return /^ftyp(heic|heix|heim|heis|hevc|mif1|msf1)/.test(brand);
}

async function decode(file: File): Promise<ImageBitmap> {
  const options: ImageBitmapOptions = { imageOrientation: 'from-image' };
  if (await isHeic(file)) {
    // Safari reads these itself. Elsewhere the converter downloads only when it's needed.
    const native = await createImageBitmap(file, options).catch(() => null);
    if (native) return native;
    const { heicTo } = await import('heic-to/csp');
    const converted = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
    return createImageBitmap(converted, options);
  }
  return createImageBitmap(file, options);
}

function encode(photo: ImageBitmap, longestSide: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, longestSide / Math.max(photo.width, photo.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(photo.width * scale);
  canvas.height = Math.round(photo.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas');
  context.fillStyle = '#ffffff'; // Transparent PNGs have no background of their own.
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(photo, 0, 0, canvas.width, canvas.height);
  // Drawing to a canvas and saving it again leaves every piece of metadata behind.
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))), 'image/jpeg', quality);
  });
}

async function encodeWithin(
  photo: ImageBitmap,
  attempts: readonly (readonly [number, number])[],
  limit: number,
): Promise<Blob> {
  let result: Blob | null = null;
  for (const [side, quality] of attempts) {
    result = await encode(photo, side, quality);
    if (result.size <= limit) return result;
  }
  return result!;
}

/** Where a metadata block could start: the two byte orders it can be written in. */
function metadataStarts(bytes: Uint8Array): number[] {
  const starts: number[] = [];
  for (let at = 0; at + 3 < bytes.length && starts.length < MAX_METADATA_TRIES; at += 1) {
    const little = bytes[at] === 0x49 && bytes[at + 1] === 0x49 && bytes[at + 2] === 0x2a && bytes[at + 3] === 0;
    const big = bytes[at] === 0x4d && bytes[at + 1] === 0x4d && bytes[at + 2] === 0 && bytes[at + 3] === 0x2a;
    if (little || big) starts.push(at);
  }
  return starts;
}

async function readLocation(file: File): Promise<AddedPhoto['location']> {
  // Plenty of photos have no readable location, and that's fine.
  const { default: exifr } = await import('exifr');
  const usable = (gps: { latitude: number; longitude: number } | undefined) =>
    gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)
      ? { lat: roundCoordinate(gps.latitude), lng: roundCoordinate(gps.longitude) }
      : null;

  const direct = usable(await exifr.gps(file).catch(() => undefined));
  if (direct || !(await isHeic(file))) return direct;

  // HEIC files are laid out in several ways, and the reader only follows some of them.
  // The metadata itself is the same, so look for it directly.
  const bytes = new Uint8Array(await file.arrayBuffer());
  for (const start of metadataStarts(bytes)) {
    const found = usable(await exifr.gps(bytes.subarray(start)).catch(() => undefined));
    if (found) return found;
  }
  return null;
}

/** About a metre, which is far more exact than any guess on a map. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

async function withRetries<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      // A full space or a refused file won't change by trying again.
      if (attempt >= ATTEMPTS || (error instanceof ApiError && error.status < 500)) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 800 * attempt));
    }
  }
}

/**
 * Prepares a photo in the browser and uploads it. Originals can be huge and carry a location,
 * so they never leave this computer: only a resized copy with no metadata does.
 */
export async function addPhoto(file: File): Promise<AddedPhoto> {
  const location = await readLocation(file);
  const photo = await decode(file);
  try {
    const { full, small } = await stills(photo);
    const id = await withRetries(() => api.uploadPhoto(full));
    await withRetries(() => api.uploadSmallPhoto(id, small));
    return { id, location };
  } finally {
    photo.close();
  }
}

/** Anything a browser calls a video, so the builder can say which kinds work rather than calling it a bad photo. */
export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|avi|mkv)$/i.test(file.name);
}

/** The kinds the server can check and clean. Phones and most editors save one of these. */
function isMp4(file: File): boolean {
  return /^video\/(mp4|quicktime|x-m4v)$/.test(file.type) || /\.(mp4|m4v|mov)$/i.test(file.name);
}

export type VideoProblem = 'kind' | 'size' | 'unplayable';

export class VideoError extends Error {
  constructor(readonly problem: VideoProblem) {
    super(`Video problem: ${problem}`);
  }
}

const POSTER_WAIT_MS = 20_000;

/** A frame from just after the start, past any fade from black. Opening it also shows this browser can play it. */
async function posterFrame(file: File): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new VideoError('unplayable')), POSTER_WAIT_MS);
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new VideoError('unplayable'));
      };
      video.onloadedmetadata = () => {
        const length = Number.isFinite(video.duration) ? video.duration : 0;
        video.currentTime = Math.max(0.001, Math.min(1, length / 4));
      };
      video.onseeked = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.src = url;
    });
    if (video.videoWidth === 0) throw new VideoError('unplayable');
    return await createImageBitmap(video);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Sends a video as it is, with a poster taken from it. The server removes the location and
 * camera details, since re-encoding a video in the browser would be slow and lose quality.
 */
export async function addVideo(file: File): Promise<AddedPhoto> {
  if (!isMp4(file)) throw new VideoError('kind');
  if (file.size > MAX_VIDEO_BYTES) throw new VideoError('size');
  const poster = await posterFrame(file);
  try {
    const { full, small } = await stills(poster);
    const id = await withRetries(() => api.uploadVideo(file));
    await withRetries(() => api.uploadPoster(id, full));
    await withRetries(() => api.uploadSmallPhoto(id, small));
    return { id, location: null };
  } finally {
    poster.close();
  }
}

export function addMedia(file: File): Promise<AddedPhoto> {
  return isVideoFile(file) ? addVideo(file) : addPhoto(file);
}

/** The TV's copy and the phones' copy of a photo or a video's poster. */
async function stills(photo: ImageBitmap): Promise<{ full: Blob; small: Blob }> {
  const full = await encodeWithin(
    photo,
    [
      [FULL_SIDE, 0.82],
      [FULL_SIDE, 0.7],
      [FULL_SIDE, 0.55],
    ],
    MAX_UPLOAD_BYTES,
  );
  const small = await encodeWithin(
    photo,
    [
      [SMALL_SIDE, 0.7],
      [SMALL_SIDE, 0.6],
      [SMALL_SIDE, 0.5],
      [SMALL_SIDE, 0.4],
      [720, 0.5],
      [720, 0.4],
    ],
    SMALL_TARGET_BYTES,
  );
  return { full, small };
}
