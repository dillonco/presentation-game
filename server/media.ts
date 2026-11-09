import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVideoId, MEDIA_ID_PATTERN } from '../shared/deck.js';
import { MAIN_SPACE, spacePrefix } from './spaces.js';
import type { Storage } from './storage/index.js';

export const MAX_IMAGE_SIDE = 4096;
/** How much the local copy may hold before the least recently used files make way. Videos are big. */
export const DEFAULT_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

/** A video keeps its stills too: `full` and `small` are its poster, shown before it plays and on phones. */
export type ImageVariant = 'full' | 'small';
export type MediaVariant = ImageVariant | 'video';

export interface CleanJpeg {
  body: Buffer;
  width: number;
  height: number;
}

/** Start of frame, for every coding process except the Huffman, arithmetic and JPEG-extension markers in this range. */
function isFrameHeader(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Huffman tables, arithmetic conditioning, quantization tables, restart interval and start of scan. */
const DRAWING_MARKERS = new Set([0xc4, 0xcc, 0xdb, 0xdd, 0xda]);

/**
 * Checks that an upload really is a complete JPEG and rebuilds it with only what's needed to
 * draw it. The browser already strips metadata, so this guarantees it even if that step is
 * skipped: no location, no camera details, nothing hidden after the end of the picture.
 */
export function cleanJpeg(input: Buffer): CleanJpeg | null {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;
  const kept: Buffer[] = [input.subarray(0, 2)];
  let at = 2;
  let width = 0;
  let height = 0;
  let scanned = false;

  while (at + 1 < input.length) {
    if (input[at] !== 0xff) return null;
    const marker = input[at + 1]!;
    if (marker === 0xff) {
      at += 1; // Padding before a marker.
      continue;
    }
    if (marker === 0xd9) {
      if (!scanned || width === 0 || height === 0) return null;
      if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return null;
      kept.push(input.subarray(at, at + 2));
      return { body: Buffer.concat(kept), width, height };
    }
    if (at + 4 > input.length) return null;
    const length = input.readUInt16BE(at + 2);
    const end = at + 2 + length;
    if (length < 2 || end > input.length) return null;

    if (isFrameHeader(marker)) {
      // Only one picture per file. A second frame header could give the size check one set of
      // dimensions while a phone draws the other, far larger, one.
      if (width !== 0 || height !== 0 || scanned || length < 7) return null;
      height = input.readUInt16BE(at + 5);
      width = input.readUInt16BE(at + 7);
      if (width === 0 || height === 0) return null;
    }
    if (marker === 0xda && width === 0) return null;
    // Only what a decoder needs is kept. Metadata, comments and any segment of unknown purpose
    // go, so nothing chosen by the uploader rides along outside the picture's own tables.
    if (DRAWING_MARKERS.has(marker) || isFrameHeader(marker)) kept.push(input.subarray(at, end));
    at = end;

    if (marker === 0xda) {
      scanned = true;
      let scan = at;
      while (scan + 1 < input.length) {
        if (input[scan] === 0xff) {
          const next = input[scan + 1]!;
          // A stuffed byte or a restart marker is still part of the picture.
          if (next !== 0x00 && (next < 0xd0 || next > 0xd7)) break;
          scan += 2;
        } else {
          scan += 1;
        }
      }
      if (scan + 1 >= input.length) return null;
      kept.push(input.subarray(at, scan));
      at = scan;
    }
  }
  return null;
}

/** Boxes at the top of a video file that hold the picture and sound, or say how to play them. */
const KEPT_TOP_BOXES = new Set(['ftyp', 'moov', 'mdat', 'moof', 'mfra', 'styp', 'sidx', 'pdin']);
/** Boxes inside `moov` that other boxes live in, and which can hold metadata further down. */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'edts', 'mvex']);
/** User data, metadata and vendor boxes: where phones put the location, camera and software. */
const METADATA_BOXES = new Set(['udta', 'meta', 'uuid', 'free', 'skip', 'wide', 'XMP_']);
/** Headers whose first fields are when the video was made and last changed. */
const DATED_BOXES = new Set(['mvhd', 'tkhd', 'mdhd']);
const MAX_BOX_DEPTH = 8;

interface Box {
  type: string;
  start: number;
  /** Where the box's contents begin, after its size and type. */
  body: number;
  end: number;
}

/** Splits a run of boxes into its parts, or gives null when they don't fit together exactly. */
function readBoxes(file: Buffer, from: number, to: number): Box[] | null {
  const boxes: Box[] = [];
  let at = from;
  while (at < to) {
    if (at + 8 > to) return null;
    let size = file.readUInt32BE(at);
    const type = file.toString('latin1', at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      const large = file.readBigUInt64BE(at + 8);
      if (large > BigInt(to - at)) return null;
      size = Number(large);
      body = at + 16;
    } else if (size === 0) {
      size = to - at; // Runs to the end.
    }
    if (size < body - at || at + size > to) return null;
    boxes.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return boxes;
}

/** Leaves the box where it is, so nothing else in the file moves, but empties it and marks it as padding. */
function blank(file: Buffer, box: Box): void {
  file.write('free', box.start + 4, 'latin1');
  file.fill(0, box.body, box.end);
}

function handlerOf(file: Buffer, trak: Box): string | null {
  const mdia = readBoxes(file, trak.body, trak.end)?.find((box) => box.type === 'mdia');
  const hdlr = mdia && readBoxes(file, mdia.body, mdia.end)?.find((box) => box.type === 'hdlr');
  if (!hdlr || hdlr.body + 12 > hdlr.end) return null;
  return file.toString('latin1', hdlr.body + 8, hdlr.body + 12);
}

function scrubInside(file: Buffer, parent: Box, depth: number): boolean {
  if (depth > MAX_BOX_DEPTH) return false;
  const boxes = readBoxes(file, parent.body, parent.end);
  if (!boxes) return false;
  for (const box of boxes) {
    if (METADATA_BOXES.has(box.type)) {
      blank(file, box);
    } else if (box.type === 'trak' && handlerOf(file, box) === 'meta') {
      // A track of timed metadata rather than picture or sound. Players never show it.
      blank(file, box);
    } else if (DATED_BOXES.has(box.type)) {
      const dateBytes = file[box.body] === 1 ? 16 : 8;
      if (box.body + 4 + dateBytes > box.end) return false;
      file.fill(0, box.body + 4, box.body + 4 + dateBytes);
    } else if (CONTAINER_BOXES.has(box.type)) {
      if (!scrubInside(file, box, depth + 1)) return false;
    }
  }
  return true;
}

/**
 * Checks that an upload is a whole MP4 or MOV video, and removes what phones and cameras add
 * beyond the picture and sound: location, device, software and dates. Emptied boxes stay in
 * place as padding, so every offset in the file still points at the same frame.
 */
export function cleanVideo(input: Buffer): Buffer | null {
  const top = readBoxes(input, 0, input.length);
  if (!top || top[0]?.type !== 'ftyp') return null;
  if (!top.some((box) => box.type === 'moov') || !top.some((box) => box.type === 'mdat' || box.type === 'moof')) {
    return null;
  }
  const file = Buffer.from(input);
  for (const box of top) {
    if (!KEPT_TOP_BOXES.has(box.type)) blank(file, box);
    else if (box.type === 'moov' && !scrubInside(file, box, 0)) return null;
  }
  return file;
}

export function newImageId(): string {
  return randomBytes(16).toString('base64url');
}

export function newVideoId(): string {
  return `v${newImageId()}`;
}

const FILE_NAMES: Record<MediaVariant, string> = { full: 'full.jpg', small: 'small.jpg', video: 'video.mp4' };
const CONTENT_TYPES: Record<MediaVariant, string> = { full: 'image/jpeg', small: 'image/jpeg', video: 'video/mp4' };

function keyFor(id: string, variant: MediaVariant): string {
  if (!MEDIA_ID_PATTERN.test(id)) throw new Error('Invalid image id');
  return `images/${id}/${FILE_NAMES[variant]}`;
}

/**
 * Photos kept in storage, which phones can't reach directly, and served by this app.
 * A copy on local disk means a roomful of phones don't each wait on storage.
 */
export class MediaStore {
  private readonly cacheDir: string;
  /** Each local file's size, least recently used first, so the copy can't fill the disk. */
  private readonly cached = new Map<string, number>();
  private cachedBytes = 0;
  private scanned: Promise<void> | null = null;

  constructor(
    private readonly storage: Storage,
    cacheDir?: string,
    private readonly maxCacheBytes: number = DEFAULT_CACHE_BYTES,
  ) {
    this.cacheDir = cacheDir ?? join(tmpdir(), 'trip-party-media');
  }

  private cachePath(id: string, variant: MediaVariant): string {
    if (!MEDIA_ID_PATTERN.test(id)) throw new Error('Invalid image id');
    return join(this.cacheDir, `${id}-${FILE_NAMES[variant]}`);
  }

  /** Counts what an earlier run left behind, once, so it's part of the limit too. */
  private scan(): Promise<void> {
    this.scanned ??= (async () => {
      const names = await readdir(this.cacheDir).catch(() => [] as string[]);
      for (const name of names) {
        const path = join(this.cacheDir, name);
        const size = await stat(path).then((info) => info.size, () => null);
        if (size !== null && !this.cached.has(path)) this.track(path, size);
      }
    })();
    return this.scanned;
  }

  private track(path: string, size: number): void {
    this.untrack(path);
    this.cached.set(path, size);
    this.cachedBytes += size;
  }

  private untrack(path: string): void {
    const size = this.cached.get(path);
    if (size === undefined) return;
    this.cached.delete(path);
    this.cachedBytes -= size;
  }

  /** Marks a local file as just used, so it's the last to go. */
  private touch(path: string): void {
    const size = this.cached.get(path);
    if (size !== undefined) this.track(path, size);
  }

  private async remember(id: string, variant: MediaVariant, body: Buffer): Promise<void> {
    await this.scan();
    await mkdir(this.cacheDir, { recursive: true });
    const path = this.cachePath(id, variant);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, body);
    await rename(temp, path);
    this.track(path, body.length);
    // A file being sent stays readable after it's removed, so this never cuts off a video mid-play.
    for (const [oldest] of this.cached) {
      if (this.cachedBytes <= this.maxCacheBytes || oldest === path) break;
      this.untrack(oldest);
      await rm(oldest, { force: true });
    }
  }

  async save(id: string, variant: MediaVariant, body: Buffer): Promise<void> {
    if (variant === 'video' && !isVideoId(id)) throw new Error('Not a video id');
    await this.storage.put(keyFor(id, variant), body, CONTENT_TYPES[variant]);
    await this.remember(id, variant, body).catch(() => undefined);
  }

  async read(id: string, variant: ImageVariant): Promise<Buffer | null> {
    const path = this.cachePath(id, variant);
    const cached = await readFile(path).catch(() => null);
    if (cached) {
      this.touch(path);
      return cached;
    }
    const stored = await this.storage.get(keyFor(id, variant));
    if (!stored) return null;
    await this.remember(id, variant, stored.body).catch(() => undefined);
    return stored.body;
  }

  /**
   * A video on local disk, fetched from storage the first time, so it can be sent in the pieces
   * a video player asks for without holding it all in memory.
   */
  async videoFile(id: string): Promise<string | null> {
    if (!isVideoId(id)) return null;
    const path = this.cachePath(id, 'video');
    if (await access(path).then(() => true, () => false)) {
      this.touch(path);
      return path;
    }
    const stored = await this.storage.get(keyFor(id, 'video'));
    if (!stored) return null;
    await this.remember(id, 'video', stored.body);
    return path;
  }

  /** A video counts once both it and its poster are here. */
  async exists(id: string): Promise<boolean> {
    if ((await this.read(id, 'full')) === null) return false;
    return !isVideoId(id) || (await this.videoFile(id)) !== null;
  }

  /** Called when a game starts, so the first phones to ask get their photo straight away. */
  async warm(ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.flatMap((id) => [
        this.read(id, 'small').catch(() => null),
        this.read(id, 'full').catch(() => null),
        this.videoFile(id).catch(() => null),
      ]),
    );
  }

  async delete(id: string): Promise<void> {
    const variants: MediaVariant[] = isVideoId(id) ? ['full', 'small', 'video'] : ['full', 'small'];
    for (const variant of variants) {
      await this.storage.delete(keyFor(id, variant));
      const path = this.cachePath(id, variant);
      this.untrack(path);
      await rm(path, { force: true });
    }
  }

  // ---------- Who owns what ----------
  //
  // Photos live at one address each, because phones load them from there. A guest sees those
  // addresses during a game, so on a hosted server each photo also records its space. A space can
  // only put its own photos in its decks, replace them or delete them. The main space is whoever
  // runs the server, and it can use any photo.

  /** Spaces already known to own a photo, so autosave doesn't ask storage on every keystroke. */
  private readonly owned = new Set<string>();

  async claim(space: string, id: string): Promise<void> {
    if (space === MAIN_SPACE) return;
    await this.storage.put(ownerKey(space, id), '', 'text/plain');
    // Also kept by photo, so the main space can tell a photo is someone else's before deleting it.
    await this.storage.put(claimKey(id), space, 'text/plain');
    this.rememberOwned(space, id);
  }

  async owns(space: string, id: string): Promise<boolean> {
    if (space === MAIN_SPACE || this.owned.has(`${space}/${id}`)) return true;
    if (!MEDIA_ID_PATTERN.test(id) || !(await this.storage.get(ownerKey(space, id)))) return false;
    this.rememberOwned(space, id);
    return true;
  }

  /** Photos and videos a space has uploaded, for its limit. */
  async countOwned(space: string): Promise<number> {
    return (await this.storage.list(`${spacePrefix(space)}media/`)).length;
  }

  /** Videos a space has uploaded, for their own, smaller limit. */
  async countOwnedVideos(space: string): Promise<number> {
    const folder = `${spacePrefix(space)}media/`;
    return (await this.storage.list(folder)).filter((key) => isVideoId(key.slice(folder.length))).length;
  }

  /** Deletes a space's photo, and its record. */
  async deleteOwned(space: string, id: string): Promise<void> {
    if (!(await this.owns(space, id))) return;
    // The main space may show any photo, but a hosted space's photo is still that space's to delete.
    if (space === MAIN_SPACE && (await this.storage.get(claimKey(id)))) return;
    await this.delete(id);
    if (space !== MAIN_SPACE) {
      await this.storage.delete(ownerKey(space, id));
      await this.storage.delete(claimKey(id));
    }
    this.owned.delete(`${space}/${id}`);
  }

  private rememberOwned(space: string, id: string): void {
    // A rough cap, so a long-running server doesn't keep every answer it has ever given.
    if (this.owned.size > 100_000) this.owned.clear();
    this.owned.add(`${space}/${id}`);
  }
}

function claimKey(id: string): string {
  if (!MEDIA_ID_PATTERN.test(id)) throw new Error('Invalid image id');
  return `owners/${id}`;
}

function ownerKey(space: string, id: string): string {
  if (!MEDIA_ID_PATTERN.test(id)) throw new Error('Invalid image id');
  return `${spacePrefix(space)}media/${id}`;
}
